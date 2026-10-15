import { closeSync, existsSync, fsyncSync, openSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { uuidv7, type Model } from "@earendil-works/pi-ai";
import {
	getAgentDir, SessionManager, type AgentSessionRuntime, type BoundaryResult, type ExtensionAPI,
	type ExtensionContext, type ExtensionFactory, type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { discoverAgents, type AgentDiscoveryResult } from "./agents.ts";
import { DEFAULT_SETTINGS } from "./config.ts";
import { prepareChildSession, persistPreparedSession } from "./providers.ts";
import { createChildRuntime, resolveExecutionProfile, runtimeFromRegistry, SelectionPersistenceError } from "./runtime.ts";
import { AgentOperationQueue, ExecutionLimiter } from "./scheduler.ts";
import {
	DEFAULT_WAIT_AGENT_TIMEOUT_MS, MAX_MESSAGE_CHARS, MAX_WAIT_AGENT_TIMEOUT_MS,
	MIN_WAIT_AGENT_TIMEOUT_MS, TOOL_NAMES,
} from "./schemas.ts";
import {
	DESCRIPTOR_CUSTOM_TYPE, MAX_PENDING_BYTES, MESSAGE_CUSTOM_TYPE, REGISTRATION_CUSTOM_TYPE, TREE_CUSTOM_TYPE,
	TREE_VERSION, TreeStore, assertAgentOpen, enqueueInState,
} from "./store.ts";
import { pathMatches, resolveTaskPath, ROOT_TASK_PATH, taskPath } from "./task-path.ts";
import { buildToolCeiling } from "./tool-policy.ts";
import { createAgentTools } from "./tools.ts";
import { inboxEnvelope, persistTaskAttribution, taskMessage } from "./task-attribution.ts";
import { addUsage, emptyUsage, finalAssistantText, finalStopReason, truncateUtf8 } from "./result.ts";
import { DashboardReader, readSession } from "./dashboard-source.ts";
import type { DashboardSnapshot, DashboardSource, TranscriptSnapshot } from "./dashboard-types.ts";
import { AgentTelemetry } from "./telemetry.ts";
import {
	DESCRIPTOR_VERSION, snapshotAgent, type AgentDefinition, type AgentDescriptor, type AgentListItem,
	type AgentRecord, type MailMessage, type SpawnInput, type SubagentSettings, type WaitResult,
} from "./types.ts";

export interface AgentCaller {
	path: string;
	depth: number;
	sessionManager: SessionManager;
	modelRuntime: ModelRuntime;
	model?: Model<any>;
	thinkingLevel: ThinkingLevel;
	projectTrusted: boolean;
	/** Ordinary-tool permission ceiling inherited by descendants. */
	tools?: string[];
}

interface ActiveRun {
	path: string;
	caller: AgentCaller;
	runtime?: AgentSessionRuntime;
	telemetry?: AgentTelemetry;
	abort: AbortController;
	accepting: boolean;
	restartAfterInterrupt: boolean;
	restartAfterBoundary: boolean;
	phase: "initializing" | "executing" | "disposing";
	lastResponse?: AgentRecord["lastResponse"];
	done: Promise<void>;
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function checkSignal(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason ?? new Error("operation aborted");
}
function validateMessage(message: string): void {
	if (typeof message !== "string" || !message.trim() || message.length > MAX_MESSAGE_CHARS) {
		throw new Error(`message must contain non-whitespace text and be at most ${MAX_MESSAGE_CHARS} characters`);
	}
	if (Buffer.byteLength(message) > MAX_PENDING_BYTES) throw new Error("message exceeds mailbox UTF-8 byte capacity");
}

/** One controller owns the whole root tree; runtime residency never defines identity. */
export class SubagentCoordinator implements DashboardSource {
	private store?: TreeStore;
	private root?: AgentCaller;
	private rootRunning = false;
	private readonly active = new Map<string, ActiveRun>();
	private readonly operations = new AgentOperationQueue();
	private readonly limiter: ExecutionLimiter;
	private readonly waiters = new Map<string, Set<(reason: "mailbox" | "input" | "shutdown") => void>>();
	private readonly discovery = new Map<string, AgentDiscoveryResult>();
	private closing = false;
	private shutdownPromise?: Promise<void>;
	private readonly dashboardReader = new DashboardReader();
	private readonly dashboardListeners = new Set<() => void>();

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly packageRoot: string,
		readonly settings: SubagentSettings = { ...DEFAULT_SETTINGS },
		private readonly agentDir: string = getAgentDir(),
	) {
		this.limiter = new ExecutionLimiter(settings.maxConcurrentAgents);
	}

	getUserAgentsDir(): string { return join(this.agentDir, "agents"); }
	get treeStore(): TreeStore {
		if (!this.store) throw new Error("pi-subagent requires a persisted root session (not --no-session)");
		return this.store;
	}
	get activeCount(): number { return this.limiter.count; }
	setRootRunning(running: boolean): void { this.rootRunning = running; }

	getSnapshot(): DashboardSnapshot {
		if (this.closing) return {
			agents: [], activeCount: 0, maxConcurrentAgents: this.settings.maxConcurrentAgents, closed: true,
		};
		return this.dashboardReader.read({
			records: Object.values(this.store?.snapshot.agents ?? {}),
			rootBranch: this.root?.sessionManager.getBranch() ?? [],
			live: path => {
				const run = this.active.get(path);
				return run?.runtime ? { session: run.runtime.session, telemetry: run.telemetry } : undefined;
			},
			activeCount: this.activeCount, maxConcurrentAgents: this.settings.maxConcurrentAgents,
		});
	}

	getTranscript(path: string, before?: string): TranscriptSnapshot {
		if (this.closing) return {
			path, status: "interrupted", entries: [], inheritedCount: 0, closed: true,
		};
		return this.dashboardReader.transcript(path, {
			records: Object.values(this.store?.snapshot.agents ?? {}),
			rootBranch: this.root?.sessionManager.getBranch() ?? [],
			live: target => {
				const run = this.active.get(target);
				return run?.runtime ? { session: run.runtime.session, telemetry: run.telemetry } : undefined;
			},
		}, before);
	}

	subscribe(listener: () => void): () => void {
		this.dashboardListeners.add(listener);
		return () => { this.dashboardListeners.delete(listener); };
	}

	private dashboardChanged(): void {
		for (const listener of this.dashboardListeners) {
			// Observers must never change admission, delivery or completion behavior.
			try { listener(); } catch { /* A failed UI observer is isolated from agent work. */ }
		}
	}

	attachRoot(ctx: ExtensionContext): AgentCaller {
		if (this.closing) throw new Error("subagent controller is shutting down");
		const manager = ctx.sessionManager as SessionManager;
		this.root = {
			path: ROOT_TASK_PATH, depth: 0, sessionManager: manager,
			modelRuntime: runtimeFromRegistry(ctx.modelRegistry), model: ctx.model,
			thinkingLevel: ctx.thinkingLevel ?? "off", projectTrusted: ctx.isProjectTrusted(),
		};
		if (!manager.getSessionFile()) return this.root;
		if (!this.store) {
			const branch = manager.getBranch();
			const oldDescriptor = branch.find(entry => entry.type === "custom" && entry.customType === DESCRIPTOR_CUSTOM_TYPE);
			if (oldDescriptor) throw new Error("standalone child/legacy subagent sessions cannot own a root tree; resume the original parent");
			const marker = [...branch].reverse().find(entry => entry.type === "custom" && entry.customType === TREE_CUSTOM_TYPE);
			const data = marker?.type === "custom" ? marker.data as { version?: number; id?: string; rootSessionId?: string } : undefined;
			if (data && data.version !== TREE_VERSION) throw new Error("unsupported subagent tree version");
			const id = data?.rootSessionId === manager.getSessionId() && data.id ? data.id : uuidv7();
			if (id !== data?.id) manager.appendCustomEntry(TREE_CUSTOM_TYPE, {
				version: TREE_VERSION, id, rootSessionId: manager.getSessionId(),
			});
			this.store = new TreeStore(manager.getSessionDir(), id, manager.getSessionId());
			// Interrupted model/tool work is never automatically replayed on recovery.
			this.store.update(state => {
				for (const record of Object.values(state.agents)) {
					if (record.status === "running" || record.status === "pending_init") {
						record.status = "interrupted";
						record.error = "Previous process ended before this run settled. Submit a follow-up to continue.";
					}
					if (record.lifecycle === "closing") {
						record.lifecycle = "closed";
						record.closedAt = new Date().toISOString();
					}
				}
			});
			this.reconcile(ROOT_TASK_PATH, manager);
			this.flushOutboxes();
		}
		return this.root;
	}

	rootCaller(ctx?: ExtensionContext): AgentCaller {
		if (ctx) return this.attachRoot(ctx);
		if (!this.root) throw new Error("subagent root session is not initialized");
		return this.root;
	}

	catalog(caller: AgentCaller): AgentDiscoveryResult {
		let catalog = this.discovery.get(caller.path);
		if (!catalog) {
			catalog = discoverAgents({
				cwd: caller.sessionManager.getCwd(), scope: this.settings.agentScope,
				projectTrusted: caller.projectTrusted, agentDir: this.agentDir,
			});
			this.discovery.set(caller.path, catalog);
		}
		return catalog;
	}

	private assertOpen(): void {
		if (this.closing) throw new Error("subagent controller is shutting down");
	}
	private session(path: string): SessionManager {
		if (path === ROOT_TASK_PATH) return this.rootCaller().sessionManager;
		const live = this.active.get(path)?.runtime?.session.sessionManager;
		if (live) return live;
		const file = this.treeStore.record(path).sessionFile;
		if (!existsSync(file)) throw new Error(`agent session is unavailable: ${path} (${file})`);
		return SessionManager.open(file);
	}
	private readOnlySession(path: string): SessionManager {
		if (path === ROOT_TASK_PATH) return this.rootCaller().sessionManager;
		return this.active.get(path)?.runtime?.session.sessionManager ?? readSession(this.treeStore.record(path));
	}
	private visible(path: string): boolean {
		if (path === ROOT_TASK_PATH) return true;
		const record = this.treeStore.snapshot.agents[path];
		if (!record || !this.visible(record.descriptor.parentPath)) return false;
		try {
			return this.readOnlySession(record.descriptor.parentPath).getBranch().some(entry => entry.id === record.descriptor.anchorId);
		} catch { return false; }
	}
	private resolve(caller: AgentCaller, target: string): string {
		this.assertOpen();
		if (!this.visible(caller.path)) throw new Error("caller is not on this tree's active branch");
		assertAgentOpen(this.treeStore.snapshot, caller.path);
		const path = resolveTaskPath(caller.path, target);
		if (!this.visible(path)) throw new Error(`unknown agent on the current branch: ${path}`);
		return path;
	}
	private selectedProfile(path: string): { model: { provider: string; id: string }; thinkingLevel: ThinkingLevel } {
		const session = this.active.get(path)?.runtime?.session;
		const descriptor = this.treeStore.record(path).descriptor;
		return {
			model: session?.model ?? descriptor.model,
			thinkingLevel: session?.thinkingLevel ?? descriptor.thinkingLevel,
		};
	}

	async spawn(caller: AgentCaller, input: SpawnInput, signal?: AbortSignal): Promise<{
		task_name: string; model: string; thinking: ThinkingLevel;
	}> {
		this.assertOpen();
		this.treeStore;
		validateMessage(input.message);
		if (input.fork_turns !== undefined && input.fork_turns !== "all" && input.fork_turns !== "none") {
			throw new Error("fork_turns must be all or none");
		}
		if (caller.depth >= this.settings.maxDepth) throw new Error(`delegation depth limit reached (${this.settings.maxDepth})`);
		const path = taskPath(caller.path, input.task_name);
		const task = taskMessage(this.pi, caller.path, path, input.message, caller.sessionManager.getSessionId());
		return this.operations.run(path, async () => {
			this.assertOpen();
			checkSignal(signal);
			if (!this.visible(caller.path)) throw new Error("caller is not on the active branch");
			assertAgentOpen(this.treeStore.snapshot, caller.path);
			if (this.treeStore.snapshot.agents[path]) throw new Error(`task name already used in this tree: ${path}`);
			const release = this.limiter.acquire();
			let transferred = false;
			try {
				const catalog = this.catalog(caller);
				const selected: AgentDefinition | undefined = input.agent_type ?
					catalog.agents.find(agent => agent.name === input.agent_type) :
					{ name: "default", description: "Default child policy", systemPrompt: "", source: "user", filePath: "" };
				if (!selected) throw new Error(`unknown agent_type: ${input.agent_type}`);
				const agent = snapshotAgent(selected);
				// A role can narrow a delegated ceiling, never broaden it.
				if (caller.tools) {
					const inherited = buildToolCeiling({ requested: caller.tools })!;
					if (agent.tools) {
						const requested = buildToolCeiling({ requested: agent.tools })!;
						const forbidden = requested.filter(tool => !inherited.includes(tool) && !(TOOL_NAMES as readonly string[]).includes(tool));
						if (forbidden.length) throw new Error(`agent_type exceeds parent's tool ceiling: ${forbidden.join(", ")}`);
					} else agent.tools = [...caller.tools];
				}
				const profile = await resolveExecutionProfile(caller.modelRuntime, caller.model,
					agent.thinking ?? caller.thinkingLevel, {
						model: input.model !== undefined ? input.model : agent.model, thinking: input.thinking,
					});
				this.assertOpen();
				checkSignal(signal);
				assertAgentOpen(this.treeStore.snapshot, caller.path);
				const model = profile.model;
				const session = prepareChildSession(caller.sessionManager, this.treeStore.sessionDirectory, input.fork_turns ?? "all");
				const anchorId = caller.sessionManager.appendCustomEntry(REGISTRATION_CUSTOM_TYPE, { treeId: this.treeStore.snapshot.id, path });
				const descriptor: AgentDescriptor = {
					version: DESCRIPTOR_VERSION, id: uuidv7(), path, parentPath: caller.path, depth: caller.depth + 1,
					cwd: caller.sessionManager.getCwd(), createdAt: new Date().toISOString(),
					agent, model: { provider: model.provider, id: model.id }, thinkingLevel: profile.thinking,
					forkTurns: input.fork_turns ?? "all", settings: { ...this.settings }, anchorId,
				};
				session.appendCustomEntry(DESCRIPTOR_CUSTOM_TYPE, descriptor);
				session.appendSessionInfo(`[subagent] ${path}`);
				const persisted = persistPreparedSession(session);
				this.treeStore.update(state => {
					assertAgentOpen(state, caller.path);
					state.agents[path] = {
						descriptor, sessionFile: persisted.getSessionFile()!, status: "pending_init", lifecycle: "open",
						mailbox: [task],
					};
				});
				this.dashboardChanged();
				transferred = true;
				try { await this.start(path, caller, persisted, release, signal); }
				catch (error) {
					if (error instanceof SelectionPersistenceError) {
						await this.active.get(path)?.done;
						this.treeStore.update(state => {
							const record = state.agents[path]!;
							// No prompt receipt exists for this typed initialization failure.
							// Retain transcript/registration traces, and any concurrent close audit.
							const pristine = record.mailbox.length === 1 && record.mailbox[0]?.id === task.id &&
								!record.outbox?.length && !Object.keys(state.agents).some(candidate =>
									candidate !== path && pathMatches(candidate, path));
							if (record.lifecycle === "open" && pristine) delete state.agents[path];
							else {
								record.status = record.lifecycle === "open" ? "errored" : "interrupted";
								record.error = errorText(error);
								if (record.lifecycle === "open") record.mailbox = record.mailbox.filter(message => message.id !== task.id);
							}
						});
					}
					throw error;
				}
				const effective = this.selectedProfile(path);
				return { task_name: path, model: `${effective.model.provider}/${effective.model.id}`, thinking: effective.thinkingLevel };
			} finally {
				if (!transferred) release();
			}
		});
	}

	send(caller: AgentCaller, target: string, text: string, signal?: AbortSignal): { accepted: true } {
		checkSignal(signal);
		validateMessage(text);
		const path = this.resolve(caller, target);
		this.treeStore.update(state => {
			assertAgentOpen(state, caller.path);
			assertAgentOpen(state, path);
			enqueueInState(state, this.message(caller.path, path, "message", text));
		});
		this.wake(path, "mailbox");
		return { accepted: true };
	}

	async followup(caller: AgentCaller, target: string, text: string, signal?: AbortSignal,
		profile?: { model?: string; thinking?: ThinkingLevel }): Promise<{
			accepted: true; model: string; thinking: ThinkingLevel;
		}> {
		validateMessage(text);
		const path = this.resolve(caller, target);
		if (path === ROOT_TASK_PATH) throw new Error("followup_task cannot start /root");
		const task = taskMessage(this.pi, caller.path, path, text, caller.sessionManager.getSessionId());
		// Initialization owns the operation queue until prompt acceptance. Profile
		// changes must fail while busy, rather than waiting there until it goes idle.
		if (this.active.has(path) && (profile?.model !== undefined || profile?.thinking !== undefined)) {
			const selected = this.selectedProfile(path);
			const requested = await resolveExecutionProfile(caller.modelRuntime,
				caller.modelRuntime.getModel(selected.model.provider, selected.model.id), selected.thinkingLevel, profile);
			this.resolve(caller, path);
			assertAgentOpen(this.treeStore.snapshot, path);
			const configured = this.selectedProfile(path);
			if (this.active.has(path) && (requested.model.provider !== configured.model.provider ||
				requested.model.id !== configured.model.id || requested.thinking !== configured.thinkingLevel)) {
				throw Object.assign(new Error("PROFILE_CHANGE_REQUIRES_IDLE: agent is busy; retry profile changes once idle"),
					{ code: "PROFILE_CHANGE_REQUIRES_IDLE" });
			}
		}
		return this.operations.run(path, async () => {
			this.assertOpen();
			checkSignal(signal);
			this.resolve(caller, path);
			assertAgentOpen(this.treeStore.snapshot, path);
			if (this.treeStore.record(path).descriptor.agent.source === "project" && !this.rootCaller().projectTrusted) {
				throw new Error("resuming a project-defined agent requires project trust");
			}
			const descriptor = this.selectedProfile(path);
			const resolved = await resolveExecutionProfile(caller.modelRuntime,
				caller.modelRuntime.getModel(descriptor.model.provider, descriptor.model.id),
				descriptor.thinkingLevel, profile);
			this.assertOpen();
			checkSignal(signal);
			this.resolve(caller, path);
			assertAgentOpen(this.treeStore.snapshot, path);
			const configured = this.selectedProfile(path);
			const changed = (profile?.model !== undefined || profile?.thinking !== undefined) &&
				(resolved.model.provider !== configured.model.provider ||
				resolved.model.id !== configured.model.id || resolved.thinking !== configured.thinkingLevel);
			let current = this.active.get(path);
			if (current && changed) throw Object.assign(
				new Error("PROFILE_CHANGE_REQUIRES_IDLE: agent is busy; retry profile changes once idle"),
				{ code: "PROFILE_CHANGE_REQUIRES_IDLE" },
			);
			if (current?.phase === "disposing") {
				await current.done;
				this.assertOpen();
				checkSignal(signal);
				this.resolve(caller, path);
				assertAgentOpen(this.treeStore.snapshot, path);
				current = undefined;
			}
			if (current) {
				this.treeStore.update(state => {
					assertAgentOpen(state, caller.path);
					assertAgentOpen(state, path);
					enqueueInState(state, task);
				});
				if (current.abort.signal.aborted) current.restartAfterInterrupt = true;
				if (!current.accepting) current.restartAfterBoundary = true;
				this.wake(path, "mailbox");
				return {
					accepted: true as const, model: `${configured.model.provider}/${configured.model.id}`,
					thinking: configured.thinkingLevel,
				};
			}
			this.flushOutboxes();
			if ((this.treeStore.record(path).outbox?.length ?? 0) >= 256) throw new Error("parent mailbox is full; collect pending results before starting more work");
			const release = this.limiter.acquire();
			let transferred = false;
			try {
				const session = this.session(path);
				this.reconcile(path, session);
				const previous = structuredClone(this.treeStore.record(path));
				this.treeStore.update(state => {
					assertAgentOpen(state, caller.path);
					assertAgentOpen(state, path);
					enqueueInState(state, task);
					const record = state.agents[path]!;
					record.descriptor.model = { provider: resolved.model.provider, id: resolved.model.id };
					record.descriptor.thinkingLevel = resolved.thinking;
				});
				transferred = true;
				try { await this.start(path, caller, session, release, signal); }
				catch (error) {
					if (error instanceof SelectionPersistenceError) {
						await this.active.get(path)?.done;
						this.treeStore.update(state => {
							const record = state.agents[path]!;
							record.descriptor = previous.descriptor;
							record.status = record.lifecycle === "open" ? previous.status : "interrupted";
							if (previous.runId === undefined) delete record.runId;
							else record.runId = previous.runId;
							if (previous.error === undefined) delete record.error;
							else record.error = previous.error;
							// A close racing this failure owns cancellation metadata.
							if (record.lifecycle === "open") record.mailbox = record.mailbox.filter(message => message.id !== task.id);
						});
					}
					throw error;
				}
				const selected = this.selectedProfile(path);
				return {
					accepted: true as const, model: `${selected.model.provider}/${selected.model.id}`,
					thinking: selected.thinkingLevel,
				};
			} finally { if (!transferred) release(); }
		});
	}

	interrupt(caller: AgentCaller, target: string): { previous_status: AgentRecord["status"] } {
		const path = this.resolve(caller, target);
		if (path === ROOT_TASK_PATH || path === caller.path) throw new Error("cannot interrupt /root or yourself");
		const previous_status = this.treeStore.record(path).status;
		const run = this.active.get(path);
		if (run) {
			run.accepting = false;
			run.restartAfterInterrupt = false;
			run.abort.abort(new Error(`interrupted by ${caller.path}`));
			void run.runtime?.session.abort().catch(error => this.reportError(path, error));
			this.wake(path, "shutdown");
		}
		return { previous_status };
	}

	close(caller: AgentCaller, target: string): {
		accepted: true; target: string; lifecycle: AgentRecord["lifecycle"]; affected_count: number;
	} {
		const path = this.resolve(caller, target);
		if (path === ROOT_TASK_PATH || path === caller.path || !pathMatches(path, caller.path)) {
			throw new Error("close_agent requires a non-root structural descendant; cannot close yourself or siblings");
		}
		const paths = Object.keys(this.treeStore.snapshot.agents).filter(candidate => pathMatches(candidate, path));
		const now = new Date().toISOString();
		// Publish a subtree-wide durable barrier before touching any runtime. In-flight
		// spawn/profile preflights must recheck their ancestors before publication.
		this.treeStore.update(state => {
			assertAgentOpen(state, caller.path);
			for (const target of paths) {
				const record = state.agents[target]!;
				if (record.lifecycle !== "open") continue;
				record.lifecycle = "closing";
				record.closeRequestedAt = now;
				record.closedBy = caller.path;
				for (const message of record.mailbox) {
					if (message.kind === "task" && !message.canceledAt) {
						message.canceledAt = now;
						message.canceledBy = caller.path;
					}
				}
			}
		});
		for (const target of paths) {
			const run = this.active.get(target);
			if (run) {
				run.accepting = false;
				run.restartAfterInterrupt = false;
				run.restartAfterBoundary = false;
				run.abort.abort(new Error(`closed by ${caller.path}`));
				void run.runtime?.session.abort().catch(error => this.reportError(target, error));
			}
			this.wake(target, "shutdown");
		}
		this.finishClosures();
		this.dashboardChanged();
		return {
			accepted: true, target: path, lifecycle: this.treeStore.record(path).lifecycle, affected_count: paths.length,
		};
	}

	private finishClosures(): void {
		if (!this.store) return;
		const settled = Object.entries(this.store.snapshot.agents).filter(([path, record]) =>
			record.lifecycle === "closing" && ![...this.active.keys()].some(active => pathMatches(active, path)));
		if (!settled.length) return;
		this.store.update(state => {
			for (const [path] of settled) {
				state.agents[path]!.lifecycle = "closed";
				state.agents[path]!.closedAt = new Date().toISOString();
			}
		});
	}

	private latestResponse(path: string): AgentRecord["lastResponse"] {
		const record = this.treeStore.record(path);
		try {
			const branch = this.readOnlySession(path).getBranch();
			const boundary = branch.findIndex(entry => entry.type === "custom" &&
				entry.customType === DESCRIPTOR_CUSTOM_TYPE &&
				(entry.data as { id?: string } | undefined)?.id === record.descriptor.id);
			if (boundary >= 0) {
				for (let index = branch.length - 1; index > boundary; index--) {
					const entry = branch[index]!;
					if (entry.type !== "message" || entry.message.role !== "assistant" ||
						!["stop", "length", "toolUse", "deferred"].includes(entry.message.stopReason)) continue;
					return {
						model: `${entry.message.provider}/${entry.message.model}`,
						...(entry.message.thinkingLevel ? { thinking: entry.message.thinkingLevel } : {}),
					};
				}
				return undefined;
			}
		} catch { /* Unreadable transcripts retain the last known durable response metadata. */ }
		return this.active.get(path)?.lastResponse ?? record.lastResponse;
	}

	list(caller: AgentCaller, prefix?: string, options: {
		include_closed?: boolean; limit?: number; cursor?: string;
	} = {}): { agents: AgentListItem[]; next_cursor?: string } {
		this.assertOpen();
		if (!this.visible(caller.path)) throw new Error("caller is not on this tree's active branch");
		const limit = options.limit ?? 50;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("limit must be an integer between 1 and 200");
		if (options.include_closed !== undefined && typeof options.include_closed !== "boolean") throw new Error("include_closed must be a boolean");
		const filter = prefix === undefined ? ROOT_TASK_PATH : resolveTaskPath(caller.path, prefix);
		const binding = JSON.stringify([this.store?.snapshot.id ?? null, caller.path, filter, options.include_closed ?? false]);
		let after = "";
		if (options.cursor !== undefined) {
			try {
				if (typeof options.cursor !== "string" || options.cursor.length > 8192) throw new Error();
				const decoded = Buffer.from(options.cursor, "base64url").toString("utf8");
				const value = JSON.parse(decoded);
				if (!Array.isArray(value) || value.length !== 2 || value[0] !== binding ||
					typeof value[1] !== "string" || Buffer.from(decoded).toString("base64url") !== options.cursor ||
					resolveTaskPath(ROOT_TASK_PATH, value[1]) !== value[1] || !pathMatches(value[1], filter)) throw new Error();
				after = value[1];
			} catch { throw new Error("invalid or mismatched list_agents cursor"); }
		}
		const root = this.rootCaller();
		const agents: AgentListItem[] = [{
			agent_name: ROOT_TASK_PATH, agent_status: this.rootRunning ? "running" : "completed",
			lifecycle: "open", model: root.model ? `${root.model.provider}/${root.model.id}` : "unavailable",
			thinking: root.thinkingLevel,
		}];
		if (this.store) {
			for (const [path, record] of Object.entries(this.store.snapshot.agents)) {
				const selected = this.selectedProfile(path);
				if (this.visible(path) && (options.include_closed || record.lifecycle !== "closed")) agents.push({
					agent_name: path, agent_status: record.status, lifecycle: record.lifecycle,
					model: `${selected.model.provider}/${selected.model.id}`,
					thinking: selected.thinkingLevel,
				});
			}
		}
		const remaining = agents.filter(agent => pathMatches(agent.agent_name, filter) && agent.agent_name > after)
			.sort((a, b) => a.agent_name < b.agent_name ? -1 : a.agent_name > b.agent_name ? 1 : 0);
		const page = remaining.slice(0, limit).map(agent => {
			const response = agent.agent_name === ROOT_TASK_PATH ? undefined : this.latestResponse(agent.agent_name);
			return response ? { ...agent, last_response: response } : agent;
		});
		return {
			agents: page,
			...(remaining.length > limit ? {
				next_cursor: Buffer.from(JSON.stringify([binding, page.at(-1)!.agent_name])).toString("base64url"),
			} : {}),
		};
	}

	wait(caller: AgentCaller, timeout = DEFAULT_WAIT_AGENT_TIMEOUT_MS, signal?: AbortSignal, hasInput = () => false): Promise<WaitResult> {
		this.assertOpen();
		assertAgentOpen(this.treeStore.snapshot, caller.path);
		checkSignal(signal);
		if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > MAX_WAIT_AGENT_TIMEOUT_MS) {
			throw new Error(`timeout_ms must be an integer between 0 and ${MAX_WAIT_AGENT_TIMEOUT_MS}`);
		}
		const milliseconds = Math.max(MIN_WAIT_AGENT_TIMEOUT_MS, timeout);
		const suffix = timeout < MIN_WAIT_AGENT_TIMEOUT_MS ? " Timeout raised to 10000 ms." : "";
		const result = (reason: "mailbox" | "input" | "timeout"): WaitResult => ({
			message: (reason === "mailbox" ? "Mailbox activity available." :
				reason === "input" ? "Wait interrupted by new input." :
					"No new mailbox activity before the wait deadline. This timeout does not cancel agents or indicate task failure.") + suffix,
			timed_out: reason === "timeout",
		});
		this.reconcile(caller.path, caller.sessionManager);
		if (this.pendingMessages(caller.path).length) return Promise.resolve(result("mailbox"));
		if (hasInput()) return Promise.resolve(result("input"));
		return new Promise((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout>;
			const listeners = this.waiters.get(caller.path) ?? new Set();
			this.waiters.set(caller.path, listeners);
			const cleanup = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				listeners.delete(wake);
				if (!listeners.size) this.waiters.delete(caller.path);
			};
			const wake = (reason: "mailbox" | "input" | "shutdown") => {
				cleanup();
				if (reason === "shutdown") reject(new Error("agent wait interrupted"));
				else resolve(result(reason));
			};
			const abort = () => { cleanup(); reject(signal?.reason ?? new Error("agent wait aborted")); };
			listeners.add(wake);
			timer = setTimeout(() => { cleanup(); resolve(result("timeout")); }, milliseconds);
			signal?.addEventListener("abort", abort, { once: true });
			// Subscribe then recheck: activity between the initial check and subscription cannot be lost.
			if (signal?.aborted) abort();
			else if (this.pendingMessages(caller.path).length) wake("mailbox");
			else if (hasInput()) wake("input");
		});
	}

	private message(from: string, to: string, kind: MailMessage["kind"], text: string): MailMessage {
		return { id: uuidv7(), from, to, kind, text, createdAt: new Date().toISOString() };
	}
	private wake(path: string, reason: "mailbox" | "input" | "shutdown"): void {
		for (const listener of [...(this.waiters.get(path) ?? [])]) listener(reason);
	}
	notifyInput(path: string): void { this.wake(path, "input"); }

	private pendingMessages(path: string): readonly MailMessage[] {
		if (path !== ROOT_TASK_PATH && this.treeStore.record(path).lifecycle !== "open") return [];
		return this.treeStore.mailbox(path).filter(message => !message.canceledAt && this.visible(message.from));
	}

	/** Receipts live with the actual context message, not with wait tool results. */
	reconcile(path: string, session: SessionManager): void {
		if (!this.store) return;
		const ids = new Set<string>();
		const file = session.getSessionFile();
		if (!file || !existsSync(file)) return;
		const persistedIds = new Set(SessionManager.open(file).getEntries().map(entry => entry.id));
		for (const entry of session.getBranch()) {
			if (!persistedIds.has(entry.id)) continue;
			const details = entry.type === "custom_message" && entry.customType === MESSAGE_CUSTOM_TYPE ? entry.details :
				entry.type === "message" && entry.message.role === "custom" && entry.message.customType === MESSAGE_CUSTOM_TYPE ?
					entry.message.details : undefined;
			const receipt = details as { treeId?: string; messageIds?: string[] } | undefined;
			if (receipt?.treeId === this.store.snapshot.id && Array.isArray(receipt.messageIds)) {
				for (const id of receipt.messageIds) ids.add(id);
			}
		}
		if (!this.store.mailbox(path).some(message => ids.has(message.id) && !message.canceledAt)) return;
		const fd = openSync(file, "r");
		try { fsyncSync(fd); } finally { closeSync(fd); }
		this.store.acknowledge(path, ids);
		this.flushOutboxes();
	}

	inboxMessage(path: string, session: SessionManager) {
		if (!this.store || this.closing) return undefined;
		this.reconcile(path, session);
		const messages = this.pendingMessages(path);
		if (!messages.length) return undefined;
		return inboxEnvelope(this.store.snapshot.id, messages);
	}

	boundary(path: string, session: SessionManager, outcome: string, beforeSettle: boolean): BoundaryResult | undefined {
		const run = this.active.get(path);
		if (this.closing || run?.abort.signal.aborted || outcome !== "completed") {
			if (beforeSettle && run) run.accepting = false;
			return undefined;
		}
		const message = this.inboxMessage(path, session);
		if (!message) {
			if (beforeSettle && run) run.accepting = false;
			return undefined;
		}
		return { entries: [{ type: "custom_message", ...message }], continue: true };
	}

	hooks(path: string): ExtensionFactory {
		return pi => {
			pi.on("before_agent_start", (_event, ctx) => {
				if (this.active.get(path)?.abort.signal.aborted) return;
				const message = this.inboxMessage(path, ctx.sessionManager as SessionManager);
				return message ? { message } : undefined;
			});
			pi.on("turn_end", (event, ctx) => this.boundary(path, ctx.sessionManager as SessionManager, event.outcome, false));
			pi.on("agent_before_settle", (event, ctx) => this.boundary(path, ctx.sessionManager as SessionManager, event.outcome, true));
			pi.on("turn_start", (_event, ctx) => this.reconcile(path, ctx.sessionManager as SessionManager));
			pi.on("input", () => { this.notifyInput(path); return { action: "continue" as const }; });
			pi.on("agent_start", () => { if (path === ROOT_TASK_PATH) this.rootRunning = true; });
			pi.on("agent_settled", (_event, ctx) => {
				this.reconcile(path, ctx.sessionManager as SessionManager);
				if (path === ROOT_TASK_PATH) this.rootRunning = false;
			});
		};
	}

	private start(path: string, initiator: AgentCaller, manager: SessionManager, release: () => void, signal?: AbortSignal): Promise<void> {
		let accept!: () => void;
		let reject!: (error: unknown) => void;
		let accepted = false;
		const acceptance = new Promise<void>((resolve, fail) => { accept = resolve; reject = fail; });
		const record = this.treeStore.record(path);
		const caller: AgentCaller = {
			path, depth: record.descriptor.depth, sessionManager: manager, modelRuntime: initiator.modelRuntime,
			model: initiator.modelRuntime.getModel(record.descriptor.model.provider, record.descriptor.model.id),
			thinkingLevel: record.descriptor.thinkingLevel, projectTrusted: this.rootCaller().projectTrusted,
			tools: record.descriptor.agent.tools,
		};
		const run: ActiveRun = {
			path, caller, abort: new AbortController(), accepting: true, restartAfterInterrupt: false, restartAfterBoundary: false,
			phase: "initializing", done: Promise.resolve(),
		};
		const abort = () => {
			run.abort.abort(signal?.reason ?? new Error("start cancelled"));
			void run.runtime?.session.abort().catch(error => this.reportError(path, error));
		};
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		this.active.set(path, run);
		this.dashboardChanged();
		run.done = (async () => {
			try {
				checkSignal(run.abort.signal);
				assertAgentOpen(this.treeStore.snapshot, initiator.path);
				assertAgentOpen(this.treeStore.snapshot, path);
				run.runtime = await createChildRuntime({
					descriptor: record.descriptor, sessionManager: manager,
					parentSession: this.session(record.descriptor.parentPath),
					modelRuntime: caller.modelRuntime, agentDir: this.agentDir, packageRoot: this.packageRoot,
					projectTrusted: caller.projectTrusted,
					tools: createAgentTools(this, ctx => ({
						...caller, model: ctx.model, thinkingLevel: ctx.thinkingLevel ?? "off",
					}), this.catalog(caller).agents, caller.path),
					hooks: this.hooks(path),
				});
				caller.sessionManager = run.runtime.session.sessionManager;
				caller.model = run.runtime.session.model;
				caller.thinkingLevel = run.runtime.session.thinkingLevel;
				checkSignal(run.abort.signal);
				run.phase = "executing";
				do {
					const runId = uuidv7();
					const session = run.runtime.session;
					const originalEntries = new Set(session.sessionManager.getEntries().map(entry => entry.id));
					run.accepting = true;
					this.treeStore.update(state => {
						assertAgentOpen(state, path);
						const agent = state.agents[path]!;
						agent.status = "running"; agent.runId = runId; delete agent.error;
						if (session.model) agent.descriptor.model = { provider: session.model.provider, id: session.model.id };
						agent.descriptor.thinkingLevel = session.thinkingLevel;
					});
					run.telemetry = new AgentTelemetry(session, runId,
						() => this.dashboardChanged(), error => this.reportError(path, error));
					this.dashboardChanged();
					this.pi.events.emit("pi-subagent:turn-start", { taskPath: path, runId });
					let failure: unknown;
					// preflight runs before Pi's operation is active. Publish acceptance
					// only once the task envelope enters that operation; otherwise an
					// immediate interrupt can race Pi resetting its abort controller.
					const unsubscribe = session.subscribe(event => {
						if (event.type === "message_end" && event.message.role === "assistant" &&
							["stop", "length", "toolUse", "deferred"].includes(event.message.stopReason)) {
							run.lastResponse = {
								model: `${event.message.provider}/${event.message.model}`,
								...(event.message.thinkingLevel ? { thinking: event.message.thinkingLevel } : {}),
							};
							this.dashboardChanged();
						}
						if (event.type !== "message_end" || event.message.role !== "custom" ||
							event.message.customType !== MESSAGE_CUSTOM_TYPE) return;
						const details = event.message.details as { treeId?: string } | undefined;
						if (details?.treeId !== this.treeStore.snapshot.id || accepted) return;
						if (run.abort.signal.aborted) return;
						accepted = true;
						signal?.removeEventListener("abort", abort);
						accept();
					});
					try {
						persistTaskAttribution(session.sessionManager, this.pendingMessages(path));
						await session.prompt("Process the assigned agent tasks and messages below.", {
							expandPromptTemplates: false, source: "extension",
							preflightResult: disposition => {
								if (disposition !== "started") throw new Error(`agent prompt was ${disposition}; task remains pending`);
								// Pi already owns a starting run here. Throwing would bypass
								// its cleanup; Pi applies a startup abort at agent_start.
							},
						});
						if (!accepted) throw new Error("task envelope was not accepted by the child");
					} catch (error) { failure = error; }
					finally { unsubscribe(); }
					this.reconcile(path, session.sessionManager);
					const newEntries = session.sessionManager.getEntries().filter(entry => !originalEntries.has(entry.id));
					const messages = newEntries.flatMap(entry => entry.type === "message" ? [entry.message] : []);
					const stop = run.abort.signal.aborted ? "aborted" :
						failure ? "error" : finalStopReason(messages, 0, "error");
					const status = stop === "completed" ? "completed" : stop === "aborted" ? "interrupted" : "errored";
					run.telemetry.finish(status);
					run.telemetry.dispose();
					run.telemetry = undefined;
					const terminal = [...messages].reverse().find(message => message.role === "assistant");
					const output = failure ? errorText(failure) : status === "errored" ?
						terminal?.errorMessage ?? `Agent stopped: ${stop}` : finalAssistantText(messages, 0);
					this.accountUsage(runId, messages);
					for (const entry of newEntries) {
						if ((entry.type === "compaction" || entry.type === "branch_summary" || entry.type === "usage") && entry.usage) {
							const model = session.model;
							if (model) this.rootCaller().sessionManager.appendUsage("pi-subagent",
								entry.type === "usage" ? entry.provider : model.provider,
								entry.type === "usage" ? entry.model : model.id, entry.usage, runId);
						}
					}
					const response = [...messages].reverse().find(message => message.role === "assistant" &&
						["stop", "length", "toolUse", "deferred"].includes(message.stopReason));
					this.settle(path, runId, status, output || (status === "errored" ? `Agent stopped: ${stop}` : "(no output)"),
						response?.role === "assistant" ? {
							model: `${response.provider}/${response.model}`,
							...(response.thinkingLevel ? { thinking: response.thinkingLevel } : {}),
						} : undefined);
					this.pi.events.emit("pi-subagent:turn-end", { taskPath: path, runId, status });
					if (!accepted) throw failure ?? new Error(`agent failed before prompt acceptance (${status})`);
					// A task accepted after the last boundary gets a fresh run. Retain the
					// permit between runs so an accepted task cannot later lose admission.
					if (this.closing || this.treeStore.record(path).lifecycle !== "open" ||
						(status === "errored" && !run.restartAfterBoundary) ||
						(run.abort.signal.aborted && !run.restartAfterInterrupt) ||
						!this.pendingMessages(path).some(message => message.kind === "task")) break;
					run.abort = new AbortController();
					run.restartAfterInterrupt = false;
					run.restartAfterBoundary = false;
				} while (true);
			} catch (error) {
				if (!accepted) reject(error);
				const record = this.treeStore.record(path);
				if (!(error instanceof SelectionPersistenceError) && (record.status === "running" || record.status === "pending_init")) {
					run.telemetry?.finish(run.abort.signal.aborted ? "interrupted" : "errored");
					this.settle(path, record.runId ?? uuidv7(), run.abort.signal.aborted ? "interrupted" : "errored", errorText(error));
				}
				this.reportError(path, error);
			} finally {
				run.phase = "disposing";
				run.telemetry?.dispose();
				run.telemetry = undefined;
				signal?.removeEventListener("abort", abort);
				run.accepting = false;
				// Followups arriving during disposal await done before creating a
				// replacement, rather than enqueueing work onto a dying runtime.
				try { await run.runtime?.dispose(); } catch (error) { this.reportError(path, error); }
				if (this.active.get(path) === run) this.active.delete(path);
				release();
				this.finishClosures();
				this.dashboardChanged();
			}
		})();
		// No detached rejection is allowed to bypass cleanup or become unhandled.
		void run.done.catch(error => this.reportError(path, error));
		return acceptance;
	}

	private settle(path: string, runId: string, status: AgentRecord["status"], output: string,
		lastResponse?: AgentRecord["lastResponse"]): void {
		const record = this.treeStore.record(path);
		const session = this.active.get(path)?.runtime?.session;
		const cap = Math.min(record.descriptor.settings.maxOutputBytes, 128 * 1024);
		const clipped = truncateUtf8(output, cap);
		const text = (status === "errored" ? "Agent failed: " : "") + clipped.text +
			(clipped.truncated ? `\n[Truncated; full output: ${record.sessionFile}]` : "");
		this.treeStore.update(state => {
			const agent = state.agents[path]!;
			agent.status = status;
			if (lastResponse) agent.lastResponse = lastResponse;
			if (session?.model) agent.descriptor.model = { provider: session.model.provider, id: session.model.id };
			if (session) agent.descriptor.thinkingLevel = session.thinkingLevel;
			if (status === "errored") agent.error = output;
			if (status !== "interrupted") {
				(agent.outbox ??= []).push({
					...this.message(path, agent.descriptor.parentPath, "completion", text), id: `completion:${runId}`, runId,
				});
			}
		});
		this.flushOutboxes();
		this.dashboardChanged();
	}

	private flushOutboxes(): void {
		if (!this.store) return;
		for (const [path, record] of Object.entries(this.store.snapshot.agents)) {
			if (!this.visible(path)) continue;
			for (const message of record.outbox ?? []) {
				try {
					this.store.update(state => {
						enqueueInState(state, message);
						state.agents[path]!.outbox = state.agents[path]!.outbox?.filter(entry => entry.id !== message.id);
					});
					if (message.to === ROOT_TASK_PATH || this.store.record(message.to).lifecycle === "open") {
						this.wake(message.to, "mailbox");
					}
				} catch (error) {
					if (!errorText(error).startsWith("mailbox capacity reached")) this.reportError(path, error);
					break;
				}
			}
		}
	}

	private accountUsage(runId: string, messages: AgentSessionRuntime["session"]["messages"]): void {
		const usageByModel = new Map<string, { provider: string; model: string; usage: ReturnType<typeof emptyUsage> }>();
		let lastModel: { provider: string; model: string; usage: ReturnType<typeof emptyUsage> } | undefined;
		for (const message of messages) {
			if (message.role === "assistant") {
				const key = JSON.stringify([message.provider, message.model]);
				let entry = usageByModel.get(key);
				if (!entry) {
					entry = { provider: message.provider, model: message.model, usage: emptyUsage() };
					usageByModel.set(key, entry);
				}
				addUsage(entry.usage, message.usage);
				lastModel = entry;
			}
			if (message.role === "toolResult" && message.usage && lastModel) addUsage(lastModel.usage, message.usage, false);
		}
		const root = this.rootCaller();
		for (const entry of usageByModel.values()) {
			if (entry.usage.totalTokens) root.sessionManager.appendUsage(
				"pi-subagent", entry.provider, entry.model, entry.usage, runId,
			);
		}
	}

	private reportError(path: string, error: unknown): void {
		this.pi.events.emit("pi-subagent:error", { taskPath: path, error: errorText(error) });
	}

	shutdown(): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise;
		this.closing = true;
		this.dashboardChanged();
		this.dashboardListeners.clear();
		this.dashboardReader.clear();
		for (const path of this.waiters.keys()) this.wake(path, "shutdown");
		for (const run of this.active.values()) {
			run.abort.abort(new Error("subagent controller shutdown"));
			void run.runtime?.session.abort().catch(error => this.reportError(run.path, error));
		}
		this.shutdownPromise = (async () => {
			await this.operations.drain();
			await Promise.allSettled([...this.active.values()].map(run => run.done));
		})();
		return this.shutdownPromise;
	}
}
