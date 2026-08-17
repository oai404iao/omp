import { randomUUID } from "node:crypto";
import { relative, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
	type AgentSessionEvent,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type ExtensionAPI,
	type ExtensionContext,
	type ModelRegistry,
	type ToolDefinition,
	type CreateAgentSessionRuntimeFactory,
	AgentSessionRuntime,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	defineTool,
	getAgentDir,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { syncBundledAgents, type AgentSyncResult } from "./agent-sync.ts";
import {
	discoverAgents,
	formatAgentCatalog,
	type AgentDiscoveryResult,
} from "./agents.ts";
import { readPersistedCatalog } from "./catalog.ts";
import { DESCRIPTOR_CUSTOM_TYPE, foldDescriptor } from "./descriptor.ts";
import {
	InterruptParameters,
	ListAgentsParameters,
	ReportParameters,
	SendMessageParameters,
	delegationParameters,
	forkDelegationParameters,
} from "./schemas.ts";
import {
	addUsage,
	emptyUsage,
	finalAssistantText,
	finalStopReason,
	formatToolArguments,
	truncateUtf8,
} from "./result.ts";
import {
	ForkProvider,
	type PreparedChildSession,
	type SessionView,
	ProviderRegistry,
	SpawnProvider,
} from "./providers.ts";
import { buildToolCeiling, resolveToolPolicy } from "./tool-policy.ts";
import {
	snapshotAgent,
	type AgentDefinition,
	type CatalogChild,
	type CatalogEntry,
	type ControlDetails,
	type DelegationDetails,
	type ParentMessageDetails,
	type SubagentDescriptor,
	type SubagentMode,
	type SubagentProviderName,
	type SubagentRunResult,
	type SubagentSettings,
	type SubagentStopReason,
	type TraceItem,
} from "./types.ts";

const REPORT_CUSTOM_TYPE = "pi-subagent/report";
const SETTLED_CUSTOM_TYPE = "pi-subagent/settled";
const MAX_TRACE_ITEMS = 100;
const MAX_TRACE_TEXT = 4000;
const BACKGROUND_CONTROL_TOOLS = new Set([
	"send_message",
	"interrupt_agent",
	"list_agents",
]);

const DELEGATION_SCOPE_PROMPT = [
	"You are a delegated Pi subagent. Work only on the task assigned in this session.",
	"Your permission and tool scope were fixed when you were created. If required access is unavailable,",
	"state the limitation instead of repeatedly retrying or asking for interactive approval.",
].join(" ");

const REPORT_PROMPT = [
	"You have a `report` tool that sends a selected update to the agent that started you.",
	"Call it with a self-contained answer before finishing, and earlier when a finding changes what the parent should do.",
	"Reporting does not end this turn and does not prevent later follow-up messages.",
].join(" ");

export interface DelegationInput {
	agent: string;
	description: string;
	prompt: string;
	run_in_background?: boolean;
}

export type DelegationOutcome =
	| { kind: "continuable"; details: DelegationDetails }
	| { kind: "foreground"; details: DelegationDetails; result: SubagentRunResult };

interface ParentRef {
	id: string;
	depth: number;
	cwd: string;
	sessionManager: SessionView;
	modelRuntime: ModelRuntime;
	model: Model<any> | undefined;
	thinkingLevel: ThinkingLevel;
	projectTrusted: boolean;
	activation?: Activation;
	deliver(
		customType: string,
		content: string,
		details: ParentMessageDetails,
		delivery: "wakeup" | "quiet",
	): Promise<void>;
}

interface Activation {
	id: string;
	epochId: string;
	descriptor: SubagentDescriptor;
	parent: ParentRef;
	runtime: AgentSessionRuntime;
	seedMessageCount: number;
	epochMessageStart: number;
	status: DelegationDetails["status"];
	trace: TraceItem[];
	streamedText: string;
	usage: ReturnType<typeof emptyUsage>;
	ownedChildren: Set<string>;
	currentRun?: Promise<SubagentRunResult>;
	pendingSettlement?: SubagentRunResult;
	unsubscribe?: () => void;
	onUpdate?: (details: DelegationDetails) => void;
	published: boolean;
	suppressSettlement: boolean;
	finalizing: boolean;
	finalizePromise?: Promise<void>;
	disposed: boolean;
	lastError?: string;
}

interface CreateActivationOptions {
	parent: ParentRef;
	descriptor: SubagentDescriptor;
	prepared: PreparedChildSession;
	isNew: boolean;
	onUpdate?: (details: DelegationDetails) => void;
}

interface CatalogRecord {
	id: string;
	descriptor: SubagentDescriptor;
	sessionFile?: string;
	active?: Activation;
}

interface CoordinatorCatalog {
	records: CatalogRecord[];
	diagnostics: CatalogEntry[];
}

function runtimeFromRegistry(registry: ModelRegistry): ModelRuntime {
	for (const value of Object.values(registry as unknown as Record<string, unknown>)) {
		if (value instanceof ModelRuntime) return value;
		if (
			value &&
			typeof value === "object" &&
			typeof (value as ModelRuntime).getModel === "function" &&
			typeof (value as ModelRuntime).streamSimple === "function" &&
			typeof (value as ModelRuntime).getAuth === "function"
		) {
			return value as ModelRuntime;
		}
	}
	throw new Error(
		"pi-subagent could not access Pi's active ModelRuntime. This extension requires Pi 0.83 or newer.",
	);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function stopReasonHeadline(reason: SubagentStopReason): string {
	switch (reason) {
		case "completed":
			return "finished";
		case "aborted":
			return "was interrupted";
		case "max-tokens":
			return "ran out of output tokens";
		case "error":
			return "failed";
	}
}

function makeRuntimeSettings(descriptor: SubagentDescriptor): SubagentSettings {
	return {
		agentScope: descriptor.runtime.agentScope,
		maxDepth: descriptor.runtime.maxDepth,
		enableRunInBackground: descriptor.runtime.enableRunInBackground,
		defaultBackground: descriptor.runtime.defaultBackground,
		reportDelivery: descriptor.runtime.reportDelivery,
		inheritExtensions: descriptor.runtime.inheritExtensions,
		maxOutputBytes: descriptor.runtime.maxOutputBytes,
	};
}

function isPathInside(parent: string, child: string): boolean {
	const rel = relative(resolve(parent), resolve(child));
	return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

export class SubagentCoordinator {
	private readonly providers = new ProviderRegistry();
	private readonly active = new Map<string, Activation>();
	private readonly agentSyncResult: AgentSyncResult;
	private draining = false;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly bundledAgentsDir: string,
		private readonly packageRoot: string,
		private readonly agentDir: string = getAgentDir(),
	) {
		this.agentSyncResult = syncBundledAgents({
			bundledDir: this.bundledAgentsDir,
			agentDir: this.agentDir,
			packageRoot: this.packageRoot,
		});
		this.providers.register(new SpawnProvider());
		this.providers.register(new ForkProvider());
	}

	getAgentSyncResult(): AgentSyncResult {
		return this.agentSyncResult;
	}

	discoverAvailableAgents(
		cwd: string,
		agentScope: SubagentSettings["agentScope"],
		projectTrusted: boolean,
	): AgentDiscoveryResult {
		return discoverAgents({
			cwd,
			scope: agentScope,
			projectTrusted,
			bundledDir: this.bundledAgentsDir,
			agentDir: this.agentDir,
			includeBundled: false,
		});
	}

	async parentFromContext(ctx: ExtensionContext): Promise<ParentRef> {
		const folded = foldDescriptor(ctx.sessionManager.getEntries());
		const descriptor = folded.kind === "valid" ? folded.descriptor : undefined;
		const modelRuntime = runtimeFromRegistry(ctx.modelRegistry);
		return {
			id: ctx.sessionManager.getSessionId(),
			depth: descriptor?.depth ?? 0,
			cwd: ctx.cwd,
			sessionManager: ctx.sessionManager,
			modelRuntime,
			model: ctx.model,
			thinkingLevel: ctx.thinkingLevel ?? "off",
			projectTrusted: ctx.isProjectTrusted(),
			deliver: async (customType, content, details, delivery) => {
				const options =
					delivery === "wakeup"
						? { triggerTurn: true, deliverAs: "followUp" as const }
						: ctx.isIdle()
							? { triggerTurn: false }
							: { triggerTurn: false, deliverAs: "nextTurn" as const };
				this.pi.sendMessage({ customType, content, display: true, details }, options);
			},
		};
	}

	async delegate(
		parent: ParentRef,
		providerName: SubagentProviderName,
		input: DelegationInput,
		settings: SubagentSettings,
		signal?: AbortSignal,
		onUpdate?: (details: DelegationDetails) => void,
		agentDiscovery?: AgentDiscoveryResult,
	): Promise<DelegationOutcome> {
		if (this.draining) throw new Error("pi-subagent is shutting down; no new delegation was accepted");
		const provider = this.providers.get(providerName);
		if (
			providerName === "spawn" &&
			!settings.enableRunInBackground &&
			input.run_in_background === true
		) {
			throw new Error(
				"run_in_background is disabled by pi-subagent foreground-only mode (enableRunInBackground: false)",
			);
		}
		const runInBackground =
			providerName === "spawn" && settings.enableRunInBackground
				? (input.run_in_background ?? settings.defaultBackground)
				: false;
		const mode: SubagentMode = runInBackground ? "continuable" : "one-shot";
		if (mode === "continuable" && !provider.supportsContinuable) {
			throw new Error(`subagent provider "${provider.name}" does not support continuable children`);
		}
		if (mode === "continuable" && !parent.sessionManager.getSessionFile()) {
			throw new Error(
				"continuable subagents require a persisted parent session; set run_in_background to false",
			);
		}
		if (mode === "continuable" && parent.activation?.descriptor.mode === "one-shot") {
			throw new Error(
				"a one-shot child cannot leave a continuable descendant behind; set run_in_background to false",
			);
		}

		const depth = parent.depth + 1;
		if (!Number.isSafeInteger(depth)) throw new Error("subagent child depth exceeds the safe-integer range");
		if (depth > settings.maxDepth) {
			throw new Error(`subagent depth ${depth} exceeds maxDepth ${settings.maxDepth}`);
		}

		const discovery =
			agentDiscovery ??
			this.discoverAvailableAgents(
				parent.cwd,
				settings.agentScope,
				parent.projectTrusted,
			);
		const agent = discovery.agents.find((candidate) => candidate.name === input.agent);
		if (!agent) {
			const diagnosticText =
				discovery.diagnostics.length > 0 ? `\nDiagnostics:\n${discovery.diagnostics.join("\n")}` : "";
			throw new Error(
				`unknown subagent "${input.agent}". Available agents:\n${formatAgentCatalog(discovery.agents)}${diagnosticText}`,
			);
		}

		const model = this.resolveModel(parent, agent);
		const thinkingLevel = agent.thinking ?? parent.thinkingLevel;
		const prepared = await provider.prepare(parent, mode);
		const descriptor: SubagentDescriptor = {
			version: 1,
			mode,
			provider: providerName,
			label: input.description.trim(),
			parentSessionId: parent.id,
			...(parent.sessionManager.getSessionFile()
				? { parentSessionFile: parent.sessionManager.getSessionFile() }
				: {}),
			depth,
			cwd: parent.cwd,
			createdAt: new Date().toISOString(),
			agent: snapshotAgent(agent),
			model: { provider: model.provider, id: model.id },
			thinkingLevel,
			runtime: {
				agentScope: settings.agentScope,
				maxDepth: settings.maxDepth,
				enableRunInBackground: settings.enableRunInBackground,
				defaultBackground: settings.defaultBackground,
				reportDelivery: settings.reportDelivery,
				inheritExtensions: settings.inheritExtensions,
				maxOutputBytes: settings.maxOutputBytes,
			},
		};

		let activation: Activation | undefined;
		try {
			activation = await this.createActivation({
				parent,
				descriptor,
				prepared,
				isNew: true,
				onUpdate,
			});
			if (mode === "continuable" && parent.activation) {
				parent.activation.ownedChildren.add(activation.id);
			}
			const started = this.startPrompt(activation, input.prompt, signal, mode === "continuable");
			await started.accepted;
			if (mode === "continuable") {
				activation.onUpdate = undefined;
				return { kind: "continuable", details: this.detailsOf(activation) };
			}

			const result = await started.result;
			const details = this.detailsOf(activation, result);
			activation.onUpdate = undefined;
			await this.disposeActivation(activation);
			return { kind: "foreground", details, result };
		} catch (error) {
			if (activation && !activation.published) {
				activation.suppressSettlement = true;
				await this.rollbackActivation(activation, prepared);
			} else if (!activation) {
				await prepared.rollback();
			}
			throw error;
		}
	}

	async sendMessage(parent: ParentRef, childId: string, message: string, signal?: AbortSignal): Promise<void> {
		if (this.draining) throw new Error("pi-subagent is shutting down; message was not delivered");
		let activation = this.active.get(childId);
		let coldPrepared: PreparedChildSession | undefined;
		if (activation?.finalizing && activation.finalizePromise) {
			await activation.finalizePromise;
			activation = undefined;
		}

		if (!activation) {
			const located = await this.findPersistedChild(parent, childId);
			if (!located) throw new Error(`unknown subagent: ${childId}; message was not delivered`);
			if (located.descriptor.mode !== "continuable") {
				throw new Error(`subagent ${childId} is one-shot and cannot accept follow-up messages`);
			}
			this.assertDirectParent(parent, located.descriptor);
			const manager = SessionManager.open(
				located.sessionFile,
				parent.sessionManager.getSessionDir(),
				parent.cwd,
			);
			coldPrepared = {
				sessionManager: manager,
				seedMessageCount: manager.buildSessionContext().messages.length,
				rollback: () => Promise.resolve(),
			};
			activation = await this.createActivation({
				parent,
				descriptor: located.descriptor,
				prepared: coldPrepared,
				isNew: false,
			});
			if (parent.activation) parent.activation.ownedChildren.add(activation.id);
		} else {
			this.assertDirectParent(parent, activation.descriptor);
		}

		const session = activation.runtime.session;
		if (activation.currentRun || session.isStreaming) {
			if (signal?.aborted) throw signal.reason ?? new Error("message delivery aborted");
			await session.followUp(message);
			return;
		}

		try {
			const started = this.startPrompt(activation, message, signal, true);
			await started.accepted;
		} catch (error) {
			if (coldPrepared && !activation.published) {
				activation.suppressSettlement = true;
				await this.rollbackActivation(activation, coldPrepared);
			}
			throw error;
		}
	}

	async interrupt(parent: ParentRef, targetId: string): Promise<void> {
		const target = this.active.get(targetId);
		if (!target) return;
		if (!(await this.isDescendantOf(parent, target.descriptor))) {
			throw new Error(`subagent ${targetId} is not a live descendant of ${parent.id}`);
		}
		target.status = "failed";
		void target.runtime.session.abort().catch((error) => {
			target.lastError = errorText(error);
		});
	}

	async list(parent: ParentRef, scope: "children" | "descendants"): Promise<CatalogEntry[]> {
		const catalog = await this.catalogRecords(parent);
		const records = catalog.records;
		const byId = new Map(records.map((record) => [record.id, record]));
		const children: CatalogChild[] = [];
		for (const record of records) {
			if (record.descriptor.mode !== "continuable") continue;
			const distance = this.distanceFrom(parent.id, record.descriptor, byId);
			if (distance === undefined || (scope === "children" && distance !== 1)) continue;
			children.push({
				kind: "child",
				id: record.id,
				parentId: record.descriptor.parentSessionId,
				depth: distance,
				descriptor: record.descriptor,
				...(record.sessionFile ? { sessionFile: record.sessionFile } : {}),
				status: record.active
					? record.active.currentRun || record.active.runtime.session.isStreaming
						? "running"
						: "idle"
					: "ready",
			});
		}
		children.sort(
			(left, right) =>
				left.descriptor.createdAt.localeCompare(right.descriptor.createdAt) || left.id.localeCompare(right.id),
		);
		const parentFile = parent.sessionManager.getSessionFile();
		const diagnostics = parentFile
			? catalog.diagnostics.filter(
					(entry) => entry.kind === "diagnostic" && entry.parentSessionFile === parentFile,
				)
			: [];
		return [...children, ...diagnostics];
	}

	async report(child: Activation, output: string): Promise<void> {
		if (child.descriptor.mode !== "continuable") {
			throw new Error("report is available only to continuable subagents");
		}
		const truncated = truncateUtf8(output, child.descriptor.runtime.maxOutputBytes);
		const content = `Background subagent ${child.id} reported:\n\n${truncated.text}${
			truncated.truncated ? `\n\n[Report truncated; ${truncated.omittedBytes} bytes omitted.]` : ""
		}`;
		await child.parent.deliver(
			REPORT_CUSTOM_TYPE,
			content,
			{
				kind: "report",
				childId: child.id,
				label: child.descriptor.label,
				...(truncated.truncated ? { truncated: true } : {}),
			},
			child.descriptor.runtime.reportDelivery,
		);
	}

	async shutdown(): Promise<void> {
		if (this.draining) return;
		this.draining = true;
		const activations = [...this.active.values()];
		for (const activation of activations) activation.suppressSettlement = true;
		await Promise.allSettled(
			activations.map(async (activation) => {
				if (!activation.runtime.session.isIdle) await activation.runtime.session.abort();
			}),
		);
		for (const activation of activations.sort((left, right) => right.descriptor.depth - left.descriptor.depth)) {
			await this.disposeActivation(activation).catch(() => {});
		}
	}

	createChildToolDefinitions(
		getActivation: () => Activation,
		enableRunInBackground = true,
		defaultBackground = true,
		agentDiscovery?: AgentDiscoveryResult,
	): ToolDefinition[] {
		const agentNames = agentDiscovery?.agents.map((agent) => agent.name);
		const assertBackgroundControlEnabled = (toolName: string): void => {
			if (!enableRunInBackground) {
				throw new Error(`tool "${toolName}" is unavailable in foreground-only mode`);
			}
		};
		const update =
			(onUpdate: AgentToolUpdateCallback<DelegationDetails> | undefined) => (details: DelegationDetails) => {
				onUpdate?.({
					content: [{ type: "text", text: this.progressText(details) }],
					details,
				});
			};

		const spawn = defineTool({
			name: "subagent",
			label: "Subagent",
			description:
				"Delegate a standalone task to a fresh child in an isolated session. " +
				(!enableRunInBackground
					? "This foreground-only instance always waits for the result."
					: defaultBackground
						? "It runs in the background by default and returns a durable id."
						: "It waits for the result by default; background mode returns a durable id."),
			parameters: delegationParameters(enableRunInBackground, agentNames),
			execute: async (_id, params, signal, onUpdate) => {
				const activation = getActivation();
				const outcome = await this.delegate(
					this.parentForActivation(activation),
					"spawn",
					params,
					makeRuntimeSettings(activation.descriptor),
					signal,
					update(onUpdate),
					agentDiscovery,
				);
				return this.outcomeToolResult(outcome);
			},
		});

		const fork = defineTool({
			name: "subagent_fork",
			label: "Subagent Fork",
			description:
				"Delegate a one-shot task to a child seeded with completed turns from this conversation.",
			parameters: forkDelegationParameters(agentNames),
			execute: async (_id, params, signal, onUpdate) => {
				const activation = getActivation();
				const outcome = await this.delegate(
					this.parentForActivation(activation),
					"fork",
					params,
					makeRuntimeSettings(activation.descriptor),
					signal,
					update(onUpdate),
					agentDiscovery,
				);
				return this.outcomeToolResult(outcome);
			},
		});

		const send = defineTool({
			name: "send_message",
			label: "Send Message",
			description:
				"Queue a message as a direct continuable child's next FIFO turn. This returns acceptance, not the child's answer.",
			parameters: SendMessageParameters,
			execute: async (_id, params, signal) => {
				assertBackgroundControlEnabled("send_message");
				const activation = getActivation();
				await this.sendMessage(
					this.parentForActivation(activation),
					params.subagent_id,
					params.message,
					signal,
				);
				return {
					content: [
						{
							type: "text",
							text: `message queued as the next turn for subagent ${params.subagent_id}`,
						},
					],
					details: { kind: "control", action: "send", id: params.subagent_id } satisfies ControlDetails,
				};
			},
		});

		const interrupt = defineTool({
			name: "interrupt_agent",
			label: "Interrupt Agent",
			description:
				"Request cancellation of a live descendant's current turn. Its durable session remains available.",
			parameters: InterruptParameters,
			execute: async (_id, params) => {
				assertBackgroundControlEnabled("interrupt_agent");
				const activation = getActivation();
				await this.interrupt(this.parentForActivation(activation), params.agent_id);
				return {
					content: [{ type: "text", text: `interrupt requested for agent ${params.agent_id}` }],
					details: { kind: "control", action: "interrupt", id: params.agent_id } satisfies ControlDetails,
				};
			},
		});

		const list = defineTool({
			name: "list_agents",
			label: "List Agents",
			description:
				"List direct continuable children or all descendants as running, idle, or ready (persisted and resumable).",
			parameters: ListAgentsParameters,
			execute: async (_id, params) => {
				assertBackgroundControlEnabled("list_agents");
				const activation = getActivation();
				const entries = await this.list(
					this.parentForActivation(activation),
					params.scope ?? "children",
				);
				return {
					content: [{ type: "text", text: this.formatCatalog(entries, params.scope ?? "children") }],
					details: { kind: "control", action: "list" } satisfies ControlDetails,
				};
			},
		});

		const report = defineTool({
			name: "report",
			label: "Report",
			description:
				"Send a self-contained update to the agent that started you. This does not end the current turn.",
			parameters: ReportParameters,
			execute: async (_id, params) => {
				const activation = getActivation();
				await this.report(activation, params.output);
				return {
					content: [{ type: "text", text: `report accepted by the agent that started you` }],
					details: { kind: "control", action: "report", id: activation.id } satisfies ControlDetails,
				};
			},
		});

		return [spawn, fork, send, interrupt, list, report];
	}

	outcomeToolResult(outcome: DelegationOutcome): AgentToolResult<DelegationDetails> {
		if (outcome.kind === "continuable") {
			return {
				content: [{ type: "text", text: `started subagent ${outcome.details.id}` }],
				details: outcome.details,
			};
		}
		if (outcome.result.stopReason !== "completed") {
			const partial = outcome.result.output.trim()
				? `\nPartial output before the run ended:\n${outcome.result.output}`
				: "";
			throw new Error(
				`subagent ${stopReasonHeadline(outcome.result.stopReason)} (${outcome.result.stopReason})${partial}`,
			);
		}
		return {
			content: [{ type: "text", text: outcome.result.output || "(no output)" }],
			details: outcome.details,
			usage: outcome.result.usage,
		};
	}

	formatCatalog(entries: CatalogEntry[], scope: "children" | "descendants"): string {
		if (entries.length === 0) return "(no subagents)";
		return entries
			.map((entry) => {
				if (entry.kind === "diagnostic") return `${entry.id} [diagnostic: ${entry.reason}]`;
				const location =
					scope === "descendants" ? ` parent=${entry.parentId} depth=${entry.depth}` : "";
				return `${entry.id} [${entry.status}]${location} — ${entry.descriptor.label} (${entry.descriptor.agent.name})`;
			})
			.join("\n");
	}

	private resolveModel(parent: ParentRef, agent: AgentDefinition): Model<any> {
		if (!agent.model) {
			if (!parent.model) throw new Error("no parent model is selected for the subagent");
			return parent.model;
		}
		const slash = agent.model.indexOf("/");
		if (slash > 0) {
			const provider = agent.model.slice(0, slash);
			const id = agent.model.slice(slash + 1);
			const resolved = parent.modelRuntime.getModel(provider, id);
			if (!resolved) throw new Error(`agent ${agent.name} references unknown model ${agent.model}`);
			return resolved;
		}
		const sameProvider = parent.model
			? parent.modelRuntime.getModel(parent.model.provider, agent.model)
			: undefined;
		if (sameProvider) return sameProvider;
		const matches = parent.modelRuntime.getModels().filter((model) => model.id === agent.model);
		if (matches.length === 1) return matches[0];
		if (matches.length === 0) throw new Error(`agent ${agent.name} references unknown model ${agent.model}`);
		throw new Error(
			`agent ${agent.name} model "${agent.model}" is ambiguous; use provider/model in its frontmatter`,
		);
	}

	private async createActivation(options: CreateActivationOptions): Promise<Activation> {
		let activation: Activation | undefined;
		const descriptor = options.descriptor;
		const agentDiscovery = this.discoverAvailableAgents(
			descriptor.cwd,
			descriptor.runtime.agentScope,
			options.parent.projectTrusted,
		);
		const customTools = this.createChildToolDefinitions(
			() => {
				if (!activation) throw new Error("subagent activation is not published yet");
				return activation;
			},
			descriptor.runtime.enableRunInBackground,
			descriptor.runtime.defaultBackground,
			agentDiscovery,
		);
		const model =
			options.parent.modelRuntime.getModel(descriptor.model.provider, descriptor.model.id) ??
			(options.parent.model?.provider === descriptor.model.provider &&
			options.parent.model.id === descriptor.model.id
				? options.parent.model
				: undefined);
		if (!model) {
			throw new Error(
				`cannot materialize subagent: model ${descriptor.model.provider}/${descriptor.model.id} is unavailable`,
			);
		}

		const appendSystemPrompt = [
			descriptor.agent.systemPrompt,
			DELEGATION_SCOPE_PROMPT,
			...(descriptor.mode === "continuable" ? [REPORT_PROMPT] : []),
		];
		const mandatoryTools = descriptor.mode === "continuable" ? ["report"] : [];
		const deniedTools = descriptor.mode === "one-shot" ? ["report"] : [];
		let toolCeiling: string[] | undefined;
		try {
			toolCeiling = buildToolCeiling({
				requested: descriptor.agent.tools,
				mandatory: mandatoryTools,
				denied: deniedTools,
			});
		} catch (error) {
			throw new Error(
				`agent ${descriptor.agent.name} tool policy is invalid: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			sessionManager,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: this.agentDir,
				modelRuntime: options.parent.modelRuntime,
				resourceLoaderOptions: {
					noExtensions: !descriptor.runtime.inheritExtensions,
					noThemes: true,
					appendSystemPrompt,
					extensionsOverride: (base) => ({
						...base,
						extensions: base.extensions.filter(
							(extension) => !isPathInside(this.packageRoot, extension.resolvedPath),
						),
					}),
				},
			});
			const created = await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model,
				thinkingLevel: descriptor.thinkingLevel,
				customTools,
				...(toolCeiling !== undefined ? { tools: toolCeiling } : {}),
			});
			return {
				...created,
				services,
				diagnostics: [
					...services.diagnostics,
					...created.extensionsResult.errors.map((error) => ({
						type: "error" as const,
						message: `${error.path}: ${error.error}`,
					})),
				],
			};
		};

		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: descriptor.cwd,
			agentDir: this.agentDir,
			sessionManager: options.prepared.sessionManager,
		});
		try {
			const fatalDiagnostics = runtime.diagnostics.filter((diagnostic) => diagnostic.type === "error");
			if (fatalDiagnostics.length > 0) {
				throw new Error(fatalDiagnostics.map((diagnostic) => diagnostic.message).join("; "));
			}
			await runtime.session.bindExtensions({ mode: "print" });
			try {
				const policy = resolveToolPolicy({
					requested: descriptor.agent.tools,
					mandatory: mandatoryTools,
					denied: deniedTools,
					registered: runtime.session.getAllTools().map((tool) => tool.name),
					active: runtime.session.getActiveToolNames(),
				});
				const activeTools = policy.activeTools.filter((tool) => {
					if (
						agentDiscovery.agents.length === 0 &&
						(tool === "subagent" || tool === "subagent_fork")
					) {
						return false;
					}
					if (
						!descriptor.runtime.enableRunInBackground &&
						BACKGROUND_CONTROL_TOOLS.has(tool)
					) {
						return false;
					}
					return true;
				});
				runtime.session.setActiveToolsByName(activeTools);
			} catch (error) {
				throw new Error(
					`agent ${descriptor.agent.name} tool policy could not be satisfied: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}

			const activeModel = runtime.session.model;
			if (!activeModel) throw new Error("child runtime has no selected model");
			descriptor.model = { provider: activeModel.provider, id: activeModel.id };
			descriptor.thinkingLevel = runtime.session.thinkingLevel;
			const persistedContext = runtime.session.sessionManager.buildSessionContext();
			if (
				persistedContext.model?.provider !== descriptor.model.provider ||
				persistedContext.model.modelId !== descriptor.model.id
			) {
				runtime.session.sessionManager.appendModelChange(
					descriptor.model.provider,
					descriptor.model.id,
				);
			}
			if (persistedContext.thinkingLevel !== descriptor.thinkingLevel) {
				runtime.session.sessionManager.appendThinkingLevelChange(descriptor.thinkingLevel);
			}
			if (options.isNew) {
				runtime.session.sessionManager.appendCustomEntry(
					DESCRIPTOR_CUSTOM_TYPE,
					structuredClone(descriptor),
				);
				runtime.session.sessionManager.appendSessionInfo(`[subagent] ${descriptor.label}`);
			}

			activation = {
				id: runtime.session.sessionId,
				epochId: randomUUID(),
				descriptor,
				parent: options.parent,
				runtime,
				seedMessageCount: options.prepared.seedMessageCount,
				epochMessageStart: runtime.session.messages.length,
				status: "starting",
				trace: [],
				streamedText: "",
				usage: emptyUsage(),
				ownedChildren: new Set(),
				onUpdate: options.onUpdate,
				published: false,
				suppressSettlement: false,
				finalizing: false,
				disposed: false,
			};
			activation.unsubscribe = runtime.session.subscribe((event) => this.observe(activation!, event));
			this.active.set(activation.id, activation);
			return activation;
		} catch (error) {
			await runtime.dispose().catch(() => {});
			throw error;
		}
	}

	private startPrompt(
		activation: Activation,
		prompt: string,
		signal: AbortSignal | undefined,
		detachAtAcceptance: boolean,
	): { accepted: Promise<void>; result: Promise<SubagentRunResult> } {
		if (activation.currentRun) throw new Error(`subagent ${activation.id} is already running`);
		if (signal?.aborted) throw signal.reason ?? new Error("subagent start aborted");
		activation.pendingSettlement = undefined;
		activation.status = "running";
		this.emitUpdate(activation);

		let resolveAccepted!: () => void;
		let rejectAccepted!: (error: Error) => void;
		let acceptedSettled = false;
		const accepted = new Promise<void>((resolvePromise, rejectPromise) => {
			resolveAccepted = resolvePromise;
			rejectAccepted = rejectPromise;
		});
		const abort = () => {
			void activation.runtime.session.abort().catch(() => {});
		};
		if (signal) signal.addEventListener("abort", abort, { once: true });

		const core = (async (): Promise<SubagentRunResult> => {
			try {
				await activation.runtime.session.prompt(prompt, {
					preflightResult: (success) => {
						if (acceptedSettled) return;
						acceptedSettled = true;
						if (success) {
							this.publish(activation);
							if (detachAtAcceptance && signal) signal.removeEventListener("abort", abort);
							resolveAccepted();
						} else {
							activation.suppressSettlement = true;
							rejectAccepted(new Error("subagent prompt was rejected before acceptance"));
						}
					},
				});
				if (!acceptedSettled) {
					acceptedSettled = true;
					this.publish(activation);
					if (detachAtAcceptance && signal) signal.removeEventListener("abort", abort);
					resolveAccepted();
				}
				return this.collectResult(activation, "completed");
			} catch (error) {
				activation.lastError = errorText(error);
				if (!acceptedSettled) {
					acceptedSettled = true;
					activation.suppressSettlement = true;
					rejectAccepted(error instanceof Error ? error : new Error(String(error)));
				}
				const fallback = signal?.aborted ? "aborted" : "error";
				const result = this.collectResult(activation, fallback);
				if (!result.output) result.output = activation.lastError;
				return result;
			} finally {
				if (signal) signal.removeEventListener("abort", abort);
			}
		})();

		let lifecycle!: Promise<SubagentRunResult>;
		lifecycle = core.then(async (result) => {
			if (activation.currentRun === lifecycle) activation.currentRun = undefined;
			await this.runFinished(activation, result);
			return result;
		});
		activation.currentRun = lifecycle;
		void lifecycle.catch(() => {});
		return { accepted, result: lifecycle };
	}

	private startInternalMessage(
		activation: Activation,
		customType: string,
		content: string,
		details: ParentMessageDetails,
	): void {
		if (activation.currentRun || activation.disposed) return;
		activation.pendingSettlement = undefined;
		activation.status = "running";
		const core = Promise.resolve()
			.then(() =>
				activation.runtime.session.sendCustomMessage(
					{ customType, content, display: true, details },
					{ triggerTurn: true, deliverAs: "followUp" },
				),
			)
			.then(
				() => this.collectResult(activation, "completed"),
				(error) => {
					activation.lastError = errorText(error);
					const result = this.collectResult(activation, "error");
					if (!result.output) result.output = activation.lastError ?? "";
					return result;
				},
			);
		let lifecycle!: Promise<SubagentRunResult>;
		lifecycle = core.then(async (result) => {
			if (activation.currentRun === lifecycle) activation.currentRun = undefined;
			await this.runFinished(activation, result);
			return result;
		});
		activation.currentRun = lifecycle;
		void lifecycle.catch(() => {});
	}

	private async runFinished(activation: Activation, result: SubagentRunResult): Promise<void> {
		activation.status = result.stopReason === "completed" ? "completed" : "failed";
		activation.pendingSettlement = result;
		this.emitUpdate(activation, result);
		if (activation.descriptor.mode === "one-shot") {
			this.emitEnd(activation, result);
			return;
		}
		if (activation.suppressSettlement || this.draining) return;
		if (activation.ownedChildren.size > 0) {
			activation.status = "waiting";
			this.emitUpdate(activation, result);
			return;
		}
		await this.finalizeContinuable(activation);
	}

	private async finalizeContinuable(activation: Activation): Promise<void> {
		if (activation.finalizing || activation.disposed || activation.currentRun) return;
		const result = activation.pendingSettlement;
		if (!result || activation.ownedChildren.size > 0) return;
		activation.finalizing = true;
		activation.finalizePromise = (async () => {
			if (!activation.suppressSettlement && !this.draining) {
				await this.deliverSettlement(activation, result).catch((error) => {
					activation.lastError = errorText(error);
				});
			}
			this.emitEnd(activation, result);
			await this.disposeActivation(activation);
			await this.releaseParentOwnership(activation);
		})();
		await activation.finalizePromise;
	}

	private async deliverSettlement(activation: Activation, result: SubagentRunResult): Promise<void> {
		const truncated = truncateUtf8(result.output, activation.descriptor.runtime.maxOutputBytes);
		const closing = truncated.text.trim()
			? `Its closing message:\n\n${truncated.text}`
			: "It left no closing message.";
		const content = `Background subagent ${activation.id} ${stopReasonHeadline(result.stopReason)} and will do no further work unless you send it more.\n\n${closing}${
			truncated.truncated ? `\n\n[Closing message truncated; ${truncated.omittedBytes} bytes omitted.]` : ""
		}`;
		await activation.parent.deliver(
			SETTLED_CUSTOM_TYPE,
			content,
			{
				kind: "settled",
				childId: activation.id,
				label: activation.descriptor.label,
				stopReason: result.stopReason,
				...(truncated.truncated ? { truncated: true } : {}),
			},
			"wakeup",
		);
	}

	private parentForActivation(activation: Activation): ParentRef {
		return {
			id: activation.id,
			depth: activation.descriptor.depth,
			cwd: activation.descriptor.cwd,
			sessionManager: activation.runtime.session.sessionManager,
			modelRuntime: activation.parent.modelRuntime,
			model: activation.runtime.session.model,
			thinkingLevel: activation.runtime.session.thinkingLevel,
			projectTrusted: activation.parent.projectTrusted,
			activation,
			deliver: async (customType, content, details, delivery) => {
				if (activation.disposed) throw new Error(`parent subagent ${activation.id} is no longer resident`);
				const session = activation.runtime.session;
				if (delivery === "quiet") {
					await session.sendCustomMessage(
						{ customType, content, display: true, details },
						session.isStreaming
							? { triggerTurn: false, deliverAs: "nextTurn" }
							: { triggerTurn: false },
					);
					return;
				}
				if (activation.currentRun || session.isStreaming) {
					await session.sendCustomMessage(
						{ customType, content, display: true, details },
						{ triggerTurn: true, deliverAs: "followUp" },
					);
					return;
				}
				this.startInternalMessage(activation, customType, content, details);
			},
		};
	}

	private collectResult(activation: Activation, fallback: SubagentStopReason): SubagentRunResult {
		const messages = activation.runtime.session.messages;
		const output = finalAssistantText(messages, activation.epochMessageStart, activation.streamedText);
		const stopReason = finalStopReason(messages, activation.epochMessageStart, fallback);
		const truncated = truncateUtf8(output, activation.descriptor.runtime.maxOutputBytes);
		const sessionFile = activation.runtime.session.sessionFile;
		return {
			id: activation.id,
			...(sessionFile ? { sessionFile } : {}),
			output: truncated.truncated
				? `${truncated.text}\n\n[Output truncated; ${truncated.omittedBytes} bytes omitted.${
						sessionFile ? ` Full output: ${sessionFile}` : " Full output remains in the active child session."
					}]`
				: truncated.text,
			stopReason,
			usage: structuredClone(activation.usage),
		};
	}

	private observe(activation: Activation, event: AgentSessionEvent): void {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			activation.streamedText += event.assistantMessageEvent.delta;
			this.emitUpdate(activation);
			return;
		}
		if (event.type === "tool_execution_start") {
			this.pushTrace(activation, {
				type: "tool",
				name: event.toolName,
				text: formatToolArguments(event.toolName, event.args as Record<string, unknown>),
			});
			this.emitUpdate(activation);
			return;
		}
		if (event.type !== "message_end") return;
		if (event.message.role === "toolResult") {
			if (event.message.usage) addUsage(activation.usage, event.message.usage, false);
			return;
		}
		if (event.message.role !== "assistant") return;
		addUsage(activation.usage, event.message.usage);
		const text = event.message.content
			.filter((part): part is Extract<(typeof event.message.content)[number], { type: "text" }> => part.type === "text")
			.map((part) => part.text)
			.join("");
		if (text.trim()) this.pushTrace(activation, { type: "text", text });
		this.emitUpdate(activation);
	}

	private pushTrace(activation: Activation, item: TraceItem): void {
		activation.trace.push({
			...item,
			text: item.text.length > MAX_TRACE_TEXT ? `${item.text.slice(0, MAX_TRACE_TEXT)}…` : item.text,
		});
		if (activation.trace.length > MAX_TRACE_ITEMS) activation.trace.splice(0, activation.trace.length - MAX_TRACE_ITEMS);
	}

	private publish(activation: Activation): void {
		if (activation.published) return;
		activation.published = true;
		this.pi.events.emit("pi-subagent:start", {
			runId: activation.epochId,
			id: activation.id,
			provider: activation.descriptor.provider,
			mode: activation.descriptor.mode,
			parentId: activation.descriptor.parentSessionId,
		});
	}

	private emitEnd(activation: Activation, result: SubagentRunResult): void {
		if (!activation.published) return;
		this.pi.events.emit("pi-subagent:end", {
			runId: activation.epochId,
			id: activation.id,
			provider: activation.descriptor.provider,
			mode: activation.descriptor.mode,
			parentId: activation.descriptor.parentSessionId,
			stopReason: result.stopReason,
			output: result.output,
		});
	}

	private detailsOf(activation: Activation, result?: SubagentRunResult): DelegationDetails {
		return {
			kind: "delegation",
			id: activation.id,
			provider: activation.descriptor.provider,
			mode: activation.descriptor.mode,
			agent: activation.descriptor.agent.name,
			label: activation.descriptor.label,
			depth: activation.descriptor.depth,
			status: activation.status,
			...(activation.runtime.session.sessionFile
				? { sessionFile: activation.runtime.session.sessionFile }
				: {}),
			...(result
				? {
						stopReason: result.stopReason,
						output: result.output,
						usage: result.usage,
					}
				: {}),
			trace: activation.trace.map((item) => ({ ...item })),
		};
	}

	private progressText(details: DelegationDetails): string {
		const latest = details.trace.at(-1);
		return latest?.text || `${details.agent}: ${details.status}`;
	}

	private emitUpdate(activation: Activation, result?: SubagentRunResult): void {
		if (!activation.onUpdate) return;
		try {
			activation.onUpdate(this.detailsOf(activation, result));
		} catch {
			// A stale tool-row update must not affect child execution.
		}
	}

	private async rollbackActivation(
		activation: Activation,
		prepared: PreparedChildSession,
	): Promise<void> {
		if (!activation.runtime.session.isIdle) await activation.runtime.session.abort().catch(() => {});
		await this.disposeActivation(activation).catch(() => {});
		await this.releaseParentOwnership(activation);
		await prepared.rollback();
	}

	private async disposeActivation(activation: Activation): Promise<void> {
		if (activation.disposed) return;
		activation.disposed = true;
		activation.unsubscribe?.();
		activation.unsubscribe = undefined;
		if (!activation.runtime.session.isIdle) await activation.runtime.session.abort().catch(() => {});
		try {
			await activation.runtime.dispose();
		} finally {
			if (this.active.get(activation.id) === activation) this.active.delete(activation.id);
		}
	}

	private async releaseParentOwnership(activation: Activation): Promise<void> {
		const owner = activation.parent.activation;
		if (!owner) return;
		owner.ownedChildren.delete(activation.id);
		if (
			!owner.currentRun &&
			owner.ownedChildren.size === 0 &&
			owner.pendingSettlement &&
			owner.descriptor.mode === "continuable"
		) {
			await this.finalizeContinuable(owner);
		}
	}

	private assertDirectParent(parent: ParentRef, descriptor: SubagentDescriptor): void {
		if (descriptor.parentSessionId !== parent.id) {
			throw new Error(
				`subagent ${descriptor.label} is not a direct child of ${parent.id}; message was not delivered`,
			);
		}
	}

	private async findPersistedChild(
		parent: ParentRef,
		childId: string,
	): Promise<{ descriptor: SubagentDescriptor; sessionFile: string } | undefined> {
		const catalog = await readPersistedCatalog(parent.sessionManager);
		const entry = catalog.descriptors.find((candidate) => candidate.id === childId);
		return entry ? { descriptor: entry.descriptor, sessionFile: entry.sessionFile } : undefined;
	}

	private async catalogRecords(parent: ParentRef): Promise<CoordinatorCatalog> {
		const persisted = await readPersistedCatalog(parent.sessionManager);
		const records = new Map<string, CatalogRecord>();
		for (const item of persisted.descriptors) {
			records.set(item.id, {
				id: item.id,
				descriptor: item.descriptor,
				sessionFile: item.sessionFile,
			});
		}
		for (const activation of this.active.values()) {
			if (activation.descriptor.cwd !== parent.cwd) continue;
			records.set(activation.id, {
				id: activation.id,
				descriptor: activation.descriptor,
				...(activation.runtime.session.sessionFile
					? { sessionFile: activation.runtime.session.sessionFile }
					: {}),
				active: activation,
			});
		}
		return {
			records: [...records.values()],
			diagnostics: persisted.diagnostics.filter((diagnostic) => !this.active.has(diagnostic.id)),
		};
	}

	private distanceFrom(
		rootId: string,
		descriptor: SubagentDescriptor,
		byId: Map<string, CatalogRecord>,
	): number | undefined {
		let parentId = descriptor.parentSessionId;
		let distance = 1;
		const visited = new Set<string>();
		while (true) {
			if (parentId === rootId) return distance;
			if (visited.has(parentId)) return undefined;
			visited.add(parentId);
			const parent = byId.get(parentId);
			if (!parent) return undefined;
			parentId = parent.descriptor.parentSessionId;
			distance++;
		}
	}

	private async isDescendantOf(parent: ParentRef, descriptor: SubagentDescriptor): Promise<boolean> {
		const { records } = await this.catalogRecords(parent);
		const byId = new Map(records.map((record) => [record.id, record]));
		return this.distanceFrom(parent.id, descriptor, byId) !== undefined;
	}
}

export { REPORT_CUSTOM_TYPE, SETTLED_CUSTOM_TYPE };
