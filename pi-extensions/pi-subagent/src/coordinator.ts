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
import { createChildRuntime, resolveModel, runtimeFromRegistry } from "./runtime.ts";
import { AgentOperationQueue, ExecutionLimiter } from "./scheduler.ts";
import {
	DEFAULT_WAIT_AGENT_TIMEOUT_MS, MAX_MESSAGE_CHARS, MAX_WAIT_AGENT_TIMEOUT_MS,
	MIN_WAIT_AGENT_TIMEOUT_MS, TOOL_NAMES,
} from "./schemas.ts";
import {
	DESCRIPTOR_CUSTOM_TYPE, MAX_PENDING_BYTES, MESSAGE_CUSTOM_TYPE, REGISTRATION_CUSTOM_TYPE, TREE_CUSTOM_TYPE,
	TREE_VERSION, TreeStore, enqueueInState,
} from "./store.ts";
import { pathMatches, resolveTaskPath, ROOT_TASK_PATH, taskPath } from "./task-path.ts";
import { buildToolCeiling } from "./tool-policy.ts";
import { createAgentTools } from "./tools.ts";
import { inboxEnvelope, persistTaskAttribution, taskMessage } from "./task-attribution.ts";
import { addUsage, emptyUsage, finalAssistantText, finalStopReason, truncateUtf8 } from "./result.ts";
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
	abort: AbortController;
	accepting: boolean;
	restartAfterInterrupt: boolean;
	restartAfterBoundary: boolean;
	phase: "initializing" | "executing" | "disposing";
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
export class SubagentCoordinator {
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
	private visible(path: string): boolean {
		if (path === ROOT_TASK_PATH) return true;
		const record = this.treeStore.snapshot.agents[path];
		if (!record || !this.visible(record.descriptor.parentPath)) return false;
		return this.session(record.descriptor.parentPath).getBranch().some(entry => entry.id === record.descriptor.anchorId);
	}
	private resolve(caller: AgentCaller, target: string): string {
		this.assertOpen();
		if (!this.visible(caller.path)) throw new Error("caller is not on this tree's active branch");
		const path = resolveTaskPath(caller.path, target);
		if (!this.visible(path)) throw new Error(`unknown agent on the current branch: ${path}`);
		return path;
	}

	async spawn(caller: AgentCaller, input: SpawnInput, signal?: AbortSignal): Promise<{ task_name: string }> {
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
				const model = resolveModel(caller.modelRuntime, caller.model, agent.model);
				const session = prepareChildSession(caller.sessionManager, this.treeStore.sessionDirectory, input.fork_turns ?? "all");
				const anchorId = caller.sessionManager.appendCustomEntry(REGISTRATION_CUSTOM_TYPE, { treeId: this.treeStore.snapshot.id, path });
				const descriptor: AgentDescriptor = {
					version: DESCRIPTOR_VERSION, id: uuidv7(), path, parentPath: caller.path, depth: caller.depth + 1,
					cwd: caller.sessionManager.getCwd(), createdAt: new Date().toISOString(),
					agent, model: { provider: model.provider, id: model.id }, thinkingLevel: agent.thinking ?? caller.thinkingLevel,
					forkTurns: input.fork_turns ?? "all", settings: { ...this.settings }, anchorId,
				};
				session.appendCustomEntry(DESCRIPTOR_CUSTOM_TYPE, descriptor);
				session.appendSessionInfo(`[subagent] ${path}`);
				const persisted = persistPreparedSession(session);
				this.treeStore.update(state => {
					state.agents[path] = {
						descriptor, sessionFile: persisted.getSessionFile()!, status: "pending_init",
						mailbox: [task],
					};
				});
				transferred = true;
				await this.start(path, caller, persisted, release, signal);
				return { task_name: path };
			} finally {
				if (!transferred) release();
			}
		});
	}

	send(caller: AgentCaller, target: string, text: string, signal?: AbortSignal): { accepted: true } {
		checkSignal(signal);
		validateMessage(text);
		const path = this.resolve(caller, target);
		this.treeStore.enqueue(this.message(caller.path, path, "message", text));
		this.wake(path, "mailbox");
		return { accepted: true };
	}

	async followup(caller: AgentCaller, target: string, text: string, signal?: AbortSignal): Promise<{ accepted: true }> {
		validateMessage(text);
		const path = this.resolve(caller, target);
		if (path === ROOT_TASK_PATH) throw new Error("followup_task cannot start /root");
		const task = taskMessage(this.pi, caller.path, path, text, caller.sessionManager.getSessionId());
		return this.operations.run(path, async () => {
			this.assertOpen();
			checkSignal(signal);
			this.resolve(caller, path);
			if (this.treeStore.record(path).descriptor.agent.source === "project" && !this.rootCaller().projectTrusted) {
				throw new Error("resuming a project-defined agent requires project trust");
			}
			let current = this.active.get(path);
			if (current?.phase === "disposing") {
				await current.done;
				this.assertOpen();
				checkSignal(signal);
				current = undefined;
			}
			if (current) {
				this.treeStore.enqueue(task);
				if (current.abort.signal.aborted) current.restartAfterInterrupt = true;
				if (!current.accepting) current.restartAfterBoundary = true;
				this.wake(path, "mailbox");
				return { accepted: true as const };
			}
			this.flushOutboxes();
			if ((this.treeStore.record(path).outbox?.length ?? 0) >= 256) throw new Error("parent mailbox is full; collect pending results before starting more work");
			const release = this.limiter.acquire();
			let transferred = false;
			try {
				const session = this.session(path);
				this.reconcile(path, session);
				this.treeStore.enqueue(task);
				transferred = true;
				await this.start(path, caller, session, release, signal);
				return { accepted: true as const };
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

	list(caller: AgentCaller, prefix?: string): { agents: AgentListItem[] } {
		this.assertOpen();
		const filter = prefix === undefined ? ROOT_TASK_PATH : resolveTaskPath(caller.path, prefix);
		const agents: AgentListItem[] = [{
			agent_name: ROOT_TASK_PATH, agent_status: this.rootRunning ? "running" : "completed",
		}];
		if (this.store) {
			for (const [path, record] of Object.entries(this.store.snapshot.agents)) {
				if (this.visible(path)) agents.push({ agent_name: path, agent_status: record.status });
			}
		}
		return { agents: agents.filter(agent => pathMatches(agent.agent_name, filter)).sort((a, b) => a.agent_name.localeCompare(b.agent_name)) };
	}

	wait(caller: AgentCaller, timeout = DEFAULT_WAIT_AGENT_TIMEOUT_MS, signal?: AbortSignal, hasInput = () => false): Promise<WaitResult> {
		this.assertOpen();
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
		return this.treeStore.mailbox(path).filter(message => this.visible(message.from));
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
		if (!this.store.mailbox(path).some(message => ids.has(message.id))) return;
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
		run.done = (async () => {
			try {
				checkSignal(run.abort.signal);
				run.runtime = await createChildRuntime({
					descriptor: record.descriptor, sessionManager: manager,
					parentSession: this.session(record.descriptor.parentPath),
					modelRuntime: caller.modelRuntime, agentDir: this.agentDir, packageRoot: this.packageRoot,
					projectTrusted: caller.projectTrusted,
					tools: createAgentTools(this, () => caller, this.catalog(caller).agents),
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
						const agent = state.agents[path]!;
						agent.status = "running"; agent.runId = runId; delete agent.error;
						if (session.model) agent.descriptor.model = { provider: session.model.provider, id: session.model.id };
						agent.descriptor.thinkingLevel = session.thinkingLevel;
					});
					this.pi.events.emit("pi-subagent:turn-start", { taskPath: path, runId });
					let failure: unknown;
					// preflight runs before Pi's operation is active. Publish acceptance
					// only once the task envelope enters that operation; otherwise an
					// immediate interrupt can race Pi resetting its abort controller.
					const unsubscribe = session.subscribe(event => {
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
								checkSignal(run.abort.signal);
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
					this.settle(path, runId, status, output || (status === "errored" ? `Agent stopped: ${stop}` : "(no output)"));
					this.pi.events.emit("pi-subagent:turn-end", { taskPath: path, runId, status });
					if (!accepted) throw failure ?? new Error(`agent failed before prompt acceptance (${status})`);
					// A task accepted after the last boundary gets a fresh run. Retain the
					// permit between runs so an accepted task cannot later lose admission.
					if (this.closing || (status === "errored" && !run.restartAfterBoundary) ||
						(run.abort.signal.aborted && !run.restartAfterInterrupt) ||
						!this.pendingMessages(path).some(message => message.kind === "task")) break;
					run.abort = new AbortController();
					run.restartAfterInterrupt = false;
					run.restartAfterBoundary = false;
				} while (true);
			} catch (error) {
				if (!accepted) reject(error);
				const record = this.treeStore.record(path);
				if (record.status === "running" || record.status === "pending_init") {
					this.settle(path, record.runId ?? uuidv7(), run.abort.signal.aborted ? "interrupted" : "errored", errorText(error));
				}
				this.reportError(path, error);
			} finally {
				run.phase = "disposing";
				signal?.removeEventListener("abort", abort);
				run.accepting = false;
				// Followups arriving during disposal await done before creating a
				// replacement, rather than enqueueing work onto a dying runtime.
				try { await run.runtime?.dispose(); } catch (error) { this.reportError(path, error); }
				if (this.active.get(path) === run) this.active.delete(path);
				release();
			}
		})();
		// No detached rejection is allowed to bypass cleanup or become unhandled.
		void run.done.catch(error => this.reportError(path, error));
		return acceptance;
	}

	private settle(path: string, runId: string, status: AgentRecord["status"], output: string): void {
		const record = this.treeStore.record(path);
		const session = this.active.get(path)?.runtime?.session;
		const cap = Math.min(record.descriptor.settings.maxOutputBytes, 128 * 1024);
		const clipped = truncateUtf8(output, cap);
		const text = (status === "errored" ? "Agent failed: " : "") + clipped.text +
			(clipped.truncated ? `\n[Truncated; full output: ${record.sessionFile}]` : "");
		this.treeStore.update(state => {
			const agent = state.agents[path]!;
			agent.status = status;
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
					this.wake(message.to, "mailbox");
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
