import { join, relative, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Model, uuidv7 } from "@earendil-works/pi-ai";
import {
	type AgentSessionEvent,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type ExtensionAPI,
	type ExtensionContext,
	type InlineExtension,
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
	catalogStatus,
	closeAgent,
	createAgentControlState,
	currentAgentTurnId,
	delegationStatus,
	finishAgentTurn,
	interruptAgentTurn,
	queueAgentTurn,
	setAgentResidency,
	startAgentTurn,
	type AgentControlState,
} from "./agent-state.ts";
import {
	discoverAgents,
	formatAgentCatalog,
	type AgentDiscoveryResult,
} from "./agents.ts";
import { readPersistedCatalog } from "./catalog.ts";
import {
	MAX_COMPLETIONS_PER_DELIVERY,
	appendCompletionUpdate,
	appendUndeliveredCompletion,
	foldCompletionMailbox,
	readCompletionMailbox,
	releaseCompletionDeliveries,
	reserveCompletionDelivery,
	unreadCompletionCounts,
	type CompletionUpdate,
} from "./completion-mailbox.ts";
import { DESCRIPTOR_CUSTOM_TYPE, foldDescriptor } from "./descriptor.ts";
import {
	claimMailboxMessages,
	commitMailboxClaim,
	enqueueMailboxMessage,
	foldOwnedMailbox,
	formatMailboxBatch,
	readMailbox,
} from "./mailbox.ts";
import {
	FollowupTaskParameters,
	InterruptParameters,
	ListAgentsParameters,
	ReportParameters,
	SendMessageParameters,
	WaitAgentParameters,
	DEFAULT_WAIT_AGENT_TIMEOUT_MS,
	MAX_WAIT_AGENT_TIMEOUT_MS,
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
import {
	AgentOperationQueue,
	BackgroundRunLimiter,
	type BackgroundRunPermit,
} from "./scheduler.ts";
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
const AGENT_CUSTOM_TYPE = "pi-subagent/agent";
const LINEAGE_CUSTOM_TYPE = "pi-subagent/lineage";
const AGENT_ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TRACE_ITEMS = 100;
const MAX_TRACE_TEXT = 4000;
const MAX_WAIT_AGENT_RESULT_BYTES = 256 * 1024;
const BACKGROUND_CONTROL_TOOLS = new Set([
	"send_message",
	"followup_task",
	"wait_agent",
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

export type SendMessageOutcome =
	| { kind: "legacy" }
	| {
			kind: "mailbox-v2";
			messageId: string;
			pendingMessages: number;
		};

export interface FollowupTaskOutcome {
	turnId: string;
	claimedMessages: number;
}

export interface WaitAgentOutcome {
	timedOut: boolean;
	timeoutMs: number;
	updates: CompletionUpdate[];
	unreadUpdates: number;
}

interface ParentRef {
	agentId: string;
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
	agentId: string;
	runId: string;
	descriptor: SubagentDescriptor;
	parent: ParentRef;
	runtime: AgentSessionRuntime;
	seedMessageCount: number;
	epochMessageStart: number;
	controlState: AgentControlState;
	trace: TraceItem[];
	streamedText: string;
	usage: ReturnType<typeof emptyUsage>;
	startedTurnIds: Set<string>;
	pendingMailboxClaims: Set<string>;
	userMessageGates: Map<string, UserMessageGate>;
	ownedChildren: Set<string>;
	currentRun?: Promise<SubagentRunResult>;
	currentMessageGate?: Promise<void>;
	pendingSettlement?: SubagentRunResult;
	unsubscribe?: () => void;
	onUpdate?: (details: DelegationDetails) => void;
	published: boolean;
	suppressSettlement: boolean;
	finalizing: boolean;
	finalizePromise?: Promise<void>;
	holdsBackgroundSlot: boolean;
	turnAbortController?: AbortController;
	persistenceGate: PersistenceGate;
	disposed: boolean;
	lastError?: string;
}

interface UserMessageGate {
	prepare(): void;
	accept(): void;
	reject(error: Error): void;
}

interface PersistenceGate {
	promise: Promise<void>;
	resolve(): void;
	reject(error: Error): void;
	readonly settled: boolean;
}

interface CompletionWaiter {
	promise: Promise<"activity" | "timeout">;
	wake(): void;
	reject(error: Error): void;
	dispose(): void;
}

interface CreateActivationOptions {
	parent: ParentRef;
	descriptor: SubagentDescriptor;
	prepared: PreparedChildSession;
	isNew: boolean;
	onUpdate?: (details: DelegationDetails) => void;
}

interface StartPromptOptions {
	detachAtAcceptance: boolean;
	waitForCapacity: boolean;
	preparePrompt?: (turnId: string) => string;
	onPromptAccepted?: (turnId: string) => void;
	acceptAfterUserMessage?: boolean;
}

interface PendingPromptStart {
	activation: Activation;
	accepted: Promise<void>;
	coldPrepared?: PreparedChildSession;
}

type SerializedSendMessageOutcome =
	| { kind: "legacy"; pending?: PendingPromptStart }
	| Extract<SendMessageOutcome, { kind: "mailbox-v2" }>;

interface PendingFollowupStart extends PendingPromptStart {
	outcome: FollowupTaskOutcome;
}

interface CatalogRecord {
	agentId: string;
	descriptor: SubagentDescriptor;
	sessionFile?: string;
	active?: Activation;
	pendingMessages: number;
	unreadUpdatesByChild: Map<string, number>;
}

interface CoordinatorCatalog {
	records: CatalogRecord[];
	diagnostics: CatalogEntry[];
	rootUnreadUpdatesByChild: Map<string, number>;
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

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new Error(signal.reason ? String(signal.reason) : "operation aborted");
}

function waitForPromise<T>(
	promise: Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(abortReason(signal));
	return new Promise<T>((resolvePromise, rejectPromise) => {
		const abort = () => {
			rejectPromise(abortReason(signal));
		};
		signal.addEventListener("abort", abort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", abort);
				resolvePromise(value);
			},
			(error) => {
				signal.removeEventListener("abort", abort);
				rejectPromise(error);
			},
		);
	});
}

function createPersistenceGate(session: Pick<SessionView, "getEntries">): PersistenceGate {
	let settled = session
		.getEntries()
		.some(
			(entry) =>
				entry.type === "message"
				&& entry.message.role === "assistant",
		);
	let resolvePromise!: () => void;
	let rejectPromise!: (error: Error) => void;
	const promise = settled
		? Promise.resolve()
		: new Promise<void>((resolve, reject) => {
				resolvePromise = resolve;
				rejectPromise = reject;
			});
	void promise.catch(() => {});
	return {
		promise,
		resolve: () => {
			if (settled) return;
			settled = true;
			resolvePromise();
		},
		reject: (error) => {
			if (settled) return;
			settled = true;
			rejectPromise(error);
		},
		get settled() {
			return settled;
		},
	};
}

/**
 * Read the durable pi-subagent control id recorded for a session, if any.
 *
 * The latest entry wins because a copied/forked Pi session may contain older
 * identity checkpoints.
 */
function readAgentId(session: Pick<SessionView, "getEntries">): string | undefined {
	const entries = session.getEntries();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (!entry) continue;
		if (entry.type !== "custom" || entry.customType !== AGENT_CUSTOM_TYPE) continue;
		const data = entry.data as { agentId?: unknown } | undefined;
		if (
			typeof data?.agentId === "string"
			&& AGENT_ID_PATTERN.test(data.agentId)
		) {
			return data.agentId;
		}
	}
	return undefined;
}

/**
 * Resolve the provider-neutral control id for a session, creating it on first
 * use. In-memory SessionManager instances retain custom entries too.
 */
function ensureAgentId(session: SessionView): string {
	const existing = readAgentId(session);
	if (existing) return existing;
	const agentId = uuidv7();
	session.appendCustomEntry(AGENT_CUSTOM_TYPE, { agentId });
	return agentId;
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
		maxConcurrentBackgroundRuns: descriptor.runtime.maxConcurrentBackgroundRuns,
		backgroundProtocol: descriptor.runtime.backgroundProtocol,
		reportDelivery: descriptor.runtime.reportDelivery,
		inheritExtensions: descriptor.runtime.inheritExtensions,
		openAIIdentity: descriptor.runtime.openAIIdentity,
		maxOutputBytes: descriptor.runtime.maxOutputBytes,
	};
}

function mailboxOwner(descriptor: SubagentDescriptor): {
	parentAgentId: string;
	agentId: string;
} {
	return {
		parentAgentId: descriptor.parentAgentId,
		agentId: descriptor.agentId,
	};
}

function completionWaiterKey(parent: ParentRef): string {
	return `${parent.agentId}:${parent.sessionManager.getSessionId()}`;
}

function waitTimeout(value: number | undefined): number {
	const timeoutMs = value ?? DEFAULT_WAIT_AGENT_TIMEOUT_MS;
	if (
		!Number.isSafeInteger(timeoutMs)
		|| timeoutMs < 0
		|| timeoutMs > MAX_WAIT_AGENT_TIMEOUT_MS
	) {
		throw new Error(
			`timeout_ms must be a safe integer between 0 and ${MAX_WAIT_AGENT_TIMEOUT_MS}`,
		);
	}
	return timeoutMs;
}

function isPathInside(parent: string, child: string): boolean {
	const rel = relative(resolve(parent), resolve(child));
	return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

function isOpenAIResponsesModel(model: Model<any>): boolean {
	return model.api === "openai-responses"
		|| model.api === "openai-codex-responses";
}

async function loadCodexIdentityInlineExtension(
	parentSessionManager: SessionView,
): Promise<InlineExtension> {
	try {
		const integration = await import(
			"@oai404iao/pi-codex-minimal-tools/subagent-inline"
		);
		return integration.createCodexSubagentInlineExtension({
			parentSessionManager,
		});
	} catch (error) {
		throw new Error(
			"openAIIdentity requires @oai404iao/pi-codex-minimal-tools with its subagent-inline export",
			{ cause: error },
		);
	}
}

export class SubagentCoordinator {
	private readonly providers = new ProviderRegistry();
	private readonly active = new Map<string, Activation>();
	private readonly agentOperations = new AgentOperationQueue();
	private readonly completionOperations = new AgentOperationQueue();
	private readonly backgroundRuns = new BackgroundRunLimiter();
	private readonly admittedOperations = new Set<Promise<unknown>>();
	private readonly completionWaiters = new Map<string, CompletionWaiter>();
	private readonly runtimeId = uuidv7();
	private agentSyncResult: AgentSyncResult | undefined;
	private draining = false;
	private shutdownPromise: Promise<void> | undefined;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly bundledAgentsDir: string,
		private readonly packageRoot: string,
		private readonly agentDir: string = getAgentDir(),
	) {
		this.providers.register(new SpawnProvider());
		this.providers.register(new ForkProvider());
	}

	synchronizeBundledAgents(): AgentSyncResult {
		this.agentSyncResult = syncBundledAgents({
			bundledDir: this.bundledAgentsDir,
			agentDir: this.agentDir,
			packageRoot: this.packageRoot,
		});
		return this.agentSyncResult;
	}

	getUserAgentsDir(): string {
		return join(this.agentDir, "agents");
	}

	configureBackgroundRuns(limit: number): void {
		this.backgroundRuns.configure(limit);
	}

	discoverAvailableAgents(
		cwd: string,
		settings: SubagentSettings,
		projectTrusted: boolean,
	): AgentDiscoveryResult {
		if (!this.agentSyncResult) {
			this.synchronizeBundledAgents();
		}
		const discovery = discoverAgents({
			cwd,
			scope: settings.agentScope,
			projectTrusted,
			agentDir: this.agentDir,
		});
		return {
			...discovery,
			diagnostics: [
				...(this.agentSyncResult?.diagnostics ?? []),
				...discovery.diagnostics,
			],
		};
	}

	async parentFromContext(ctx: ExtensionContext): Promise<ParentRef> {
		const folded = foldDescriptor(ctx.sessionManager.getEntries());
		const descriptor = folded.kind === "valid" ? folded.descriptor : undefined;
		const modelRuntime = runtimeFromRegistry(ctx.modelRegistry);
		return {
			agentId: readAgentId(ctx.sessionManager) ?? ensureAgentId(
				ctx.sessionManager as unknown as SessionView,
			),
			depth: descriptor?.depth ?? 0,
			cwd: ctx.cwd,
			// ExtensionContext narrows the live SessionManager to a read-only
			// view; appending the agent entry through the same instance keeps
			// the in-memory tree and the session file consistent.
			sessionManager: ctx.sessionManager as unknown as SessionView,
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
		return this.runAdmittedOperation(() =>
			this.delegateAdmitted(
				parent,
				providerName,
				input,
				settings,
				signal,
				onUpdate,
				agentDiscovery,
			),
		);
	}

	private async delegateAdmitted(
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
				settings,
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
		if (this.draining) {
			await prepared.rollback();
			throw new Error("pi-subagent is shutting down; no new delegation was accepted");
		}
		parent.agentId = ensureAgentId(parent.sessionManager);
		const openAIIdentityEnabled =
			settings.openAIIdentity && isOpenAIResponsesModel(model);
		const descriptor: SubagentDescriptor = {
			version: 2,
			mode,
			provider: providerName,
			label: input.description.trim(),
			agentId: uuidv7(),
			parentAgentId: parent.agentId,
			parentPiSessionId: parent.sessionManager.getSessionId(),
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
				maxConcurrentBackgroundRuns: settings.maxConcurrentBackgroundRuns,
				backgroundProtocol: settings.backgroundProtocol ?? "legacy",
				reportDelivery: settings.reportDelivery,
				inheritExtensions: settings.inheritExtensions,
				openAIIdentity: openAIIdentityEnabled,
				maxOutputBytes: settings.maxOutputBytes,
			},
		};
		prepared.sessionManager.appendCustomEntry(AGENT_CUSTOM_TYPE, {
			agentId: descriptor.agentId,
		});
		prepared.sessionManager.appendCustomEntry(LINEAGE_CUSTOM_TYPE, {
			version: 1,
			agentId: descriptor.agentId,
			parentAgentId: descriptor.parentAgentId,
			parentPiSessionId: descriptor.parentPiSessionId,
			relation: descriptor.provider,
			agentName: descriptor.agent.name,
			openAIIdentity: openAIIdentityEnabled,
			...(descriptor.parentSessionFile
				? { parentSessionFile: descriptor.parentSessionFile }
				: {}),
		});

		let activation: Activation | undefined;
		try {
			activation = await this.createActivation({
				parent,
				descriptor,
				prepared,
				isNew: true,
				onUpdate,
			});
			if (this.draining) {
				throw new Error("pi-subagent is shutting down; no new delegation was accepted");
			}
			if (mode === "continuable" && parent.activation) {
				parent.activation.ownedChildren.add(activation.agentId);
			}
			const started = this.startPrompt(activation, input.prompt, signal, {
				detachAtAcceptance: mode === "continuable",
				waitForCapacity: !parent.activation?.holdsBackgroundSlot,
			});
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

	async sendMessage(
		parent: ParentRef,
		childId: string,
		message: string,
		signal?: AbortSignal,
	): Promise<void> {
		await this.sendMessageWithOutcome(parent, childId, message, signal);
	}

	async sendMessageWithOutcome(
		parent: ParentRef,
		childId: string,
		message: string,
		signal?: AbortSignal,
	): Promise<SendMessageOutcome> {
		return this.runAdmittedOperation(() =>
			this.sendMessageAdmitted(parent, childId, message, signal),
		);
	}

	private async sendMessageAdmitted(
		parent: ParentRef,
		childId: string,
		message: string,
		signal?: AbortSignal,
	): Promise<SendMessageOutcome> {
		if (this.draining) throw new Error("pi-subagent is shutting down; message was not delivered");
		const delivery = await this.agentOperations.run(childId, () =>
			this.sendMessageSerialized(parent, childId, message, signal),
		);
		if (delivery.kind === "mailbox-v2") return delivery;
		const pending = delivery.pending;
		if (!pending) return { kind: "legacy" };
		try {
			await pending.accepted;
		} catch (error) {
			if (pending.coldPrepared && !pending.activation.published) {
				await this.agentOperations.run(childId, async () => {
					if (this.active.get(childId) !== pending.activation) return;
					pending.activation.suppressSettlement = true;
					await this.rollbackActivation(
						pending.activation,
						pending.coldPrepared!,
					);
				});
			}
			throw error;
		}
		return { kind: "legacy" };
	}

	private async sendMessageSerialized(
		parent: ParentRef,
		childId: string,
		message: string,
		signal?: AbortSignal,
	): Promise<SerializedSendMessageOutcome> {
		if (this.draining) {
			throw new Error("pi-subagent is shutting down; message was not delivered");
		}
		let activation = this.active.get(childId);
		let coldPrepared: PreparedChildSession | undefined;
		if (activation?.disposed) activation = undefined;
		if (activation) {
			this.assertContinuableDirectChild(parent, activation.descriptor);
			if (activation.descriptor.runtime.backgroundProtocol === "mailbox-v2") {
				if (signal?.aborted) throw abortReason(signal);
				await waitForPromise(activation.persistenceGate.promise, signal);
				if (this.draining || activation.disposed) {
					throw new Error(
						`subagent ${childId} became unavailable before its mailbox could be persisted`,
					);
				}
				const enqueued = enqueueMailboxMessage(
					activation.runtime.session.sessionManager,
					{
						senderAgentId: parent.agentId,
						recipientAgentId: childId,
						content: message,
					},
				);
				return {
					kind: "mailbox-v2",
					messageId: enqueued.message.messageId,
					pendingMessages: enqueued.pendingMessages,
				};
			}
		}
		if (activation?.pendingSettlement && !activation.currentRun) {
			await this.finalizeContinuableLocked(activation);
			if (activation.disposed || this.active.get(childId) !== activation) {
				activation = undefined;
			}
		}
		if (!activation) {
			const located = await this.findPersistedChild(parent, childId);
			if (!located) throw new Error(`unknown subagent: ${childId}; message was not delivered`);
			this.assertContinuableDirectChild(parent, located.descriptor);
			const manager = SessionManager.open(
				located.sessionFile,
				parent.sessionManager.getSessionDir(),
				parent.cwd,
			);
			if (located.descriptor.runtime.backgroundProtocol === "mailbox-v2") {
				if (signal?.aborted) throw abortReason(signal);
				const enqueued = enqueueMailboxMessage(manager, {
					senderAgentId: parent.agentId,
					recipientAgentId: childId,
					content: message,
				});
				return {
					kind: "mailbox-v2",
					messageId: enqueued.message.messageId,
					pendingMessages: enqueued.pendingMessages,
				};
			}
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
			if (parent.activation) parent.activation.ownedChildren.add(activation.agentId);
		} else {
			this.assertContinuableDirectChild(parent, activation.descriptor);
		}

		const session = activation.runtime.session;
		if (activation.currentRun || session.isStreaming) {
			if (signal?.aborted) throw signal.reason ?? new Error("message delivery aborted");
			if (activation.controlState.turn.state === "queued") {
				if (!activation.currentMessageGate) {
					throw new Error(
						`subagent ${activation.agentId} is queued but has no message gate`,
					);
				}
				return {
					kind: "legacy",
					pending: {
						activation,
						accepted: waitForPromise(
							activation.currentMessageGate,
							signal,
						).then(() => {
							if (signal?.aborted) throw abortReason(signal);
							return session.followUp(message);
						}),
					},
				};
			}
			await session.followUp(message);
			return { kind: "legacy" };
		}

		try {
			const started = this.startPrompt(activation, message, signal, {
				detachAtAcceptance: true,
				waitForCapacity: !parent.activation?.holdsBackgroundSlot,
			});
			return {
				kind: "legacy",
				pending: {
					activation,
					accepted: started.accepted,
					...(coldPrepared ? { coldPrepared } : {}),
				},
			};
		} catch (error) {
			if (coldPrepared && !activation.published) {
				activation.suppressSettlement = true;
				await this.rollbackActivation(activation, coldPrepared);
			}
			throw error;
		}
	}

	async followupTask(
		parent: ParentRef,
		childId: string,
		signal?: AbortSignal,
	): Promise<FollowupTaskOutcome> {
		return this.runAdmittedOperation(() =>
			this.followupTaskAdmitted(parent, childId, signal),
		);
	}

	private async followupTaskAdmitted(
		parent: ParentRef,
		childId: string,
		signal?: AbortSignal,
	): Promise<FollowupTaskOutcome> {
		if (this.draining) {
			throw new Error("pi-subagent is shutting down; follow-up task was not started");
		}
		const pending = await this.agentOperations.run(childId, () =>
			this.followupTaskSerialized(parent, childId, signal),
		);
		try {
			await pending.accepted;
		} catch (error) {
			if (pending.coldPrepared && !pending.activation.published) {
				await this.agentOperations.run(childId, async () => {
					if (this.active.get(childId) !== pending.activation) return;
					pending.activation.suppressSettlement = true;
					await this.rollbackActivation(
						pending.activation,
						pending.coldPrepared!,
					);
				});
			}
			throw error;
		}
		return pending.outcome;
	}

	private async followupTaskSerialized(
		parent: ParentRef,
		childId: string,
		signal?: AbortSignal,
	): Promise<PendingFollowupStart> {
		if (this.draining) {
			throw new Error("pi-subagent is shutting down; follow-up task was not started");
		}
		if (signal?.aborted) throw abortReason(signal);
		let activation = this.active.get(childId);
		if (activation?.disposed) activation = undefined;
		let descriptor: SubagentDescriptor;
		let manager: SessionManager;
		let coldPrepared: PreparedChildSession | undefined;

		if (activation) {
			descriptor = activation.descriptor;
			this.assertContinuableDirectChild(parent, descriptor);
			manager = activation.runtime.session.sessionManager;
			if (activation.currentRun || activation.runtime.session.isStreaming) {
				throw new Error(
					`subagent ${childId} already has a scheduled or running turn; mailbox messages were not consumed`,
				);
			}
		} else {
			const located = await this.findPersistedChild(parent, childId);
			if (!located) {
				throw new Error(`unknown subagent: ${childId}; follow-up task was not started`);
			}
			descriptor = located.descriptor;
			this.assertContinuableDirectChild(parent, descriptor);
			manager = SessionManager.open(
				located.sessionFile,
				parent.sessionManager.getSessionDir(),
				parent.cwd,
			);
		}
		if (descriptor.runtime.backgroundProtocol !== "mailbox-v2") {
			throw new Error(
				`subagent ${childId} uses the legacy background protocol; use send_message to start its next turn`,
			);
		}

		const owner = mailboxOwner(descriptor);
		const batch = readMailbox(manager.getEntries(), owner).pending;
		if (batch.length === 0) {
			throw new Error(`subagent ${childId} has no pending mailbox messages`);
		}
		const messageIds = batch.map((message) => message.messageId);

		if (!activation) {
			coldPrepared = {
				sessionManager: manager,
				seedMessageCount: manager.buildSessionContext().messages.length,
				rollback: () => Promise.resolve(),
			};
			activation = await this.createActivation({
				parent,
				descriptor,
				prepared: coldPrepared,
				isNew: false,
			});
			if (parent.activation) parent.activation.ownedChildren.add(activation.agentId);
		}

		try {
			const started = this.startPrompt(activation, "", signal, {
				detachAtAcceptance: true,
				waitForCapacity: !parent.activation?.holdsBackgroundSlot,
				preparePrompt: (turnId) =>
					formatMailboxBatch(batch, turnId),
				onPromptAccepted: (turnId) => {
					claimMailboxMessages(
						manager,
						messageIds,
						turnId,
						owner,
					);
					activation.pendingMailboxClaims.add(turnId);
				},
				acceptAfterUserMessage: true,
			});
			return {
				activation,
				accepted: started.accepted,
				...(coldPrepared ? { coldPrepared } : {}),
				outcome: {
					turnId: started.turnId,
					claimedMessages: batch.length,
				},
			};
		} catch (error) {
			if (coldPrepared && !activation.published) {
				activation.suppressSettlement = true;
				await this.rollbackActivation(activation, coldPrepared);
			}
			throw error;
		}
	}

	async waitAgent(
		parent: ParentRef,
		toolCallId: string,
		timeoutMs?: number,
		signal?: AbortSignal,
	): Promise<WaitAgentOutcome> {
		return this.runAdmittedOperation(() =>
			this.waitAgentAdmitted(
				parent,
				toolCallId,
				waitTimeout(timeoutMs),
				signal,
			),
		);
	}

	private async waitAgentAdmitted(
		parent: ParentRef,
		toolCallId: string,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<WaitAgentOutcome> {
		if (this.draining) {
			throw new Error("pi-subagent is shutting down; wait_agent was not accepted");
		}
		if (signal?.aborted) throw abortReason(signal);
		if (!toolCallId.trim() || toolCallId.length > 512) {
			throw new Error("wait_agent requires a non-empty tool call id of at most 512 characters");
		}
		const key = completionWaiterKey(parent);
		const deadline = Date.now() + timeoutMs;
		while (true) {
			let waiter: CompletionWaiter | undefined;
			const immediate = await this.completionOperations.run(
				key,
				async (): Promise<WaitAgentOutcome | undefined> => {
					if (this.draining) {
						throw new Error("pi-subagent is shutting down; wait_agent was interrupted");
					}
					if (signal?.aborted) throw abortReason(signal);
					if (this.completionWaiters.has(key)) {
						throw new Error(
							`wait_agent is already waiting for direct-child activity on ${parent.agentId}`,
						);
					}
					const snapshot = readCompletionMailbox(
						parent.sessionManager.getEntries(),
						{
							parentAgentId: parent.agentId,
							activeRuntimeId: this.runtimeId,
						},
					);
					if (snapshot.currentRuntimeReservations.length > 0) {
						throw new Error(
							"a previous wait_agent delivery is awaiting its durable tool result",
						);
					}
					if (snapshot.available.length > 0) {
						return this.reserveWaitAgentOutcome(
							parent,
							toolCallId,
							timeoutMs,
							snapshot,
						);
					}
					const remaining = Math.max(0, deadline - Date.now());
					if (remaining === 0) {
						return {
							timedOut: true,
							timeoutMs,
							updates: [],
							unreadUpdates: snapshot.unread.length,
						};
					}
					waiter = this.createCompletionWaiter(remaining, signal);
					this.completionWaiters.set(key, waiter);

					// Append happens before notify, but fold once more after
					// subscription so no completion can land in the check/register gap.
					const rechecked = readCompletionMailbox(
						parent.sessionManager.getEntries(),
						{
							parentAgentId: parent.agentId,
							activeRuntimeId: this.runtimeId,
						},
					);
					if (rechecked.available.length > 0) {
						try {
							return this.reserveWaitAgentOutcome(
								parent,
								toolCallId,
								timeoutMs,
								rechecked,
							);
						} finally {
							this.removeCompletionWaiter(key, waiter);
							waiter = undefined;
						}
					}
					return undefined;
				},
			);
			if (immediate) return immediate;
			if (!waiter) {
				throw new Error("wait_agent failed to establish an activity subscription");
			}
			let activity: "activity" | "timeout";
			try {
				activity = await waiter.promise;
			} catch (error) {
				this.removeCompletionWaiter(key, waiter);
				throw error;
			}
			const afterWake = await this.completionOperations.run(
				key,
				async (): Promise<WaitAgentOutcome | undefined> => {
					try {
						if (this.draining) {
							throw new Error(
								"pi-subagent is shutting down; wait_agent was interrupted",
							);
						}
						if (signal?.aborted) throw abortReason(signal);
						if (this.completionWaiters.get(key) !== waiter) {
							throw new Error(
								"wait_agent lost ownership of its activity subscription",
							);
						}
						const snapshot = readCompletionMailbox(
							parent.sessionManager.getEntries(),
							{
								parentAgentId: parent.agentId,
								activeRuntimeId: this.runtimeId,
							},
						);
						if (snapshot.currentRuntimeReservations.length > 0) {
							throw new Error(
								"a previous wait_agent delivery is awaiting its durable tool result",
							);
						}
						if (snapshot.available.length > 0) {
							return this.reserveWaitAgentOutcome(
								parent,
								toolCallId,
								timeoutMs,
								snapshot,
							);
						}
						if (activity === "timeout" || Date.now() >= deadline) {
							return {
								timedOut: true,
								timeoutMs,
								updates: [],
								unreadUpdates: snapshot.unread.length,
							};
						}
						return undefined;
					} finally {
						this.removeCompletionWaiter(key, waiter!);
					}
				},
			);
			if (afterWake) return afterWake;
		}
	}

	private reserveWaitAgentOutcome(
		parent: ParentRef,
		toolCallId: string,
		timeoutMs: number,
		snapshot: ReturnType<typeof readCompletionMailbox>,
	): WaitAgentOutcome {
		const updates = this.boundedWaitAgentUpdates(snapshot.available);
		reserveCompletionDelivery(parent.sessionManager, {
			parentAgentId: parent.agentId,
			runtimeId: this.runtimeId,
			toolCallId,
			completionIds: updates.map((update) => update.completionId),
		});
		return {
			timedOut: false,
			timeoutMs,
			updates,
			unreadUpdates: Math.max(
				0,
				snapshot.unread.length - updates.length,
			),
		};
	}

	private boundedWaitAgentUpdates(
		available: readonly CompletionUpdate[],
	): CompletionUpdate[] {
		const updates: CompletionUpdate[] = [];
		let remainingBytes = MAX_WAIT_AGENT_RESULT_BYTES;
		for (const update of available) {
			if (updates.length >= MAX_COMPLETIONS_PER_DELIVERY) break;
			const metadataBytes = Buffer.byteLength(
				`completion ${update.completionId}\nchild=${update.childAgentId} turn=${update.turnId} stop=${update.stopReason}\n`,
				"utf8",
			) + 256;
			const fullBytes =
				metadataBytes + Buffer.byteLength(update.output, "utf8");
			if (updates.length > 0 && fullBytes > remainingBytes) break;
			const outputBudget = Math.max(0, remainingBytes - metadataBytes);
			const truncated = truncateUtf8(update.output, outputBudget);
			updates.push({
				...update,
				output: truncated.text,
				...(truncated.truncated || update.outputTruncated
					? {
							outputTruncated: true,
							omittedBytes:
								(update.omittedBytes ?? 0)
								+ truncated.omittedBytes,
						}
					: {}),
			});
			remainingBytes = Math.max(
				0,
				remainingBytes
					- metadataBytes
					- Buffer.byteLength(truncated.text, "utf8"),
			);
			if (truncated.truncated) break;
		}
		return updates;
	}

	async releaseWaitAgentDeliveries(
		parent: ParentRef,
		reason: string,
	): Promise<number> {
		const key = completionWaiterKey(parent);
		return this.completionOperations.run(key, async () =>
			releaseCompletionDeliveries(parent.sessionManager, {
				parentAgentId: parent.agentId,
				runtimeId: this.runtimeId,
				reason,
			}),
		);
	}

	private createCompletionWaiter(
		timeoutMs: number,
		signal?: AbortSignal,
	): CompletionWaiter {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let resolvePromise!: (activity: "activity" | "timeout") => void;
		let rejectPromise!: (error: Error) => void;
		const promise = new Promise<"activity" | "timeout">(
			(resolve, reject) => {
				resolvePromise = resolve;
				rejectPromise = reject;
			},
		);
		const onAbort = () => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			rejectPromise(abortReason(signal!));
		};
		if (signal) signal.addEventListener("abort", onAbort, { once: true });
		timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			if (signal) signal.removeEventListener("abort", onAbort);
			resolvePromise("timeout");
		}, timeoutMs);
		timer.unref?.();
		const dispose = () => {
			if (timer) clearTimeout(timer);
			if (signal) signal.removeEventListener("abort", onAbort);
		};
		return {
			promise,
			wake: () => {
				if (settled) return;
				settled = true;
				dispose();
				resolvePromise("activity");
			},
			reject: (error) => {
				if (settled) return;
				settled = true;
				dispose();
				rejectPromise(error);
			},
			dispose,
		};
	}

	private removeCompletionWaiter(
		key: string,
		waiter: CompletionWaiter,
	): void {
		if (this.completionWaiters.get(key) === waiter) {
			this.completionWaiters.delete(key);
		}
		waiter.dispose();
	}

	async interrupt(parent: ParentRef, targetId: string): Promise<void> {
		return this.runAdmittedOperation(() =>
			this.interruptAdmitted(parent, targetId),
		);
	}

	private async interruptAdmitted(parent: ParentRef, targetId: string): Promise<void> {
		await this.agentOperations.run(targetId, async () => {
			const target = this.active.get(targetId);
			if (!target) return;
			if (!(await this.isDescendantOf(parent, target.descriptor))) {
				throw new Error(`subagent ${targetId} is not a live descendant of ${parent.agentId}`);
			}
			interruptAgentTurn(target.controlState);
			this.emitUpdate(target);
			target.turnAbortController?.abort(
				new Error(`subagent ${targetId} was interrupted`),
			);
			void target.runtime.session.abort().catch((error) => {
				target.lastError = errorText(error);
			});
		});
	}

	async list(parent: ParentRef, scope: "children" | "descendants"): Promise<CatalogEntry[]> {
		return this.runAdmittedOperation(() => this.listAdmitted(parent, scope));
	}

	private async listAdmitted(
		parent: ParentRef,
		scope: "children" | "descendants",
	): Promise<CatalogEntry[]> {
		const catalog = await this.catalogRecords(parent);
		const records = catalog.records;
		const byId = new Map(records.map((record) => [record.agentId, record]));
		const children: CatalogChild[] = [];
		for (const record of records) {
			if (record.descriptor.mode !== "continuable") continue;
			const distance = this.distanceFrom(parent.agentId, record.descriptor, byId);
			if (distance === undefined || (scope === "children" && distance !== 1)) continue;
			children.push({
				kind: "child",
				agentId: record.agentId,
				parentAgentId: record.descriptor.parentAgentId,
				depth: distance,
				descriptor: record.descriptor,
				...(record.sessionFile ? { sessionFile: record.sessionFile } : {}),
				status: record.active ? catalogStatus(record.active.controlState) : "ready",
				pendingMessages: record.pendingMessages,
				unreadUpdates:
					record.descriptor.parentAgentId === parent.agentId
						? (catalog.rootUnreadUpdatesByChild.get(record.agentId) ?? 0)
						: (byId
								.get(record.descriptor.parentAgentId)
								?.unreadUpdatesByChild.get(record.agentId) ?? 0),
			});
		}
		children.sort(
			(left, right) =>
				left.descriptor.createdAt.localeCompare(right.descriptor.createdAt) ||
				left.agentId.localeCompare(right.agentId),
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
		return this.runAdmittedOperation(() => this.reportAdmitted(child, output));
	}

	private async reportAdmitted(child: Activation, output: string): Promise<void> {
		if (child.descriptor.mode !== "continuable") {
			throw new Error("report is available only to continuable subagents");
		}
		const truncated = truncateUtf8(output, child.descriptor.runtime.maxOutputBytes);
		const content = `Background subagent ${child.agentId} reported:\n\n${truncated.text}${
			truncated.truncated ? `\n\n[Report truncated; ${truncated.omittedBytes} bytes omitted.]` : ""
		}`;
		await child.parent.deliver(
			REPORT_CUSTOM_TYPE,
			content,
			{
				kind: "report",
				childAgentId: child.agentId,
				label: child.descriptor.label,
				...(truncated.truncated ? { truncated: true } : {}),
			},
			child.descriptor.runtime.reportDelivery,
		);
	}

	private runAdmittedOperation<T>(operation: () => Promise<T>): Promise<T> {
		if (this.draining) {
			return Promise.reject(new Error("pi-subagent is shutting down"));
		}
		const promise = operation();
		this.admittedOperations.add(promise);
		const remove = () => {
			this.admittedOperations.delete(promise);
		};
		void promise.then(remove, remove);
		return promise;
	}

	private async waitForAdmittedOperations(): Promise<void> {
		while (this.admittedOperations.size > 0) {
			await Promise.allSettled([...this.admittedOperations]);
		}
	}

	async shutdown(): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise;
		this.draining = true;
		this.rejectCompletionWaiters(
			new Error("pi-subagent is shutting down"),
		);
		this.shutdownPromise = this.performShutdown();
		return this.shutdownPromise;
	}

	private async performShutdown(): Promise<void> {
		this.backgroundRuns.close();
		await this.abortActiveRuns();
		await this.agentOperations.waitForIdle();
		await this.completionOperations.waitForIdle();
		await this.abortActiveRuns();
		await this.waitForAdmittedOperations();
		await this.agentOperations.waitForIdle();
		await this.abortActiveRuns();
		const activations = [...this.active.values()];
		await Promise.allSettled(
			activations
				.map((activation) => activation.currentRun)
				.filter(
					(run): run is Promise<SubagentRunResult> => run !== undefined,
				),
		);
		for (const activation of activations.sort((left, right) => right.descriptor.depth - left.descriptor.depth)) {
			await this.disposeActivation(activation).catch(() => {});
		}
		await this.agentOperations.waitForIdle();
		await this.completionOperations.waitForIdle();
	}

	private rejectCompletionWaiters(error: Error): void {
		for (const [key, waiter] of this.completionWaiters) {
			this.completionWaiters.delete(key);
			waiter.reject(error);
			waiter.dispose();
		}
	}

	private async abortActiveRuns(): Promise<void> {
		const activations = [...this.active.values()];
		for (const activation of activations) {
			activation.suppressSettlement = true;
			activation.turnAbortController?.abort(
				new Error("pi-subagent is shutting down"),
			);
		}
		await Promise.allSettled(
			activations.map(async (activation) => {
				if (!activation.runtime.session.isIdle) {
					await activation.runtime.session.abort();
				}
			}),
		);
	}

	createChildToolDefinitions(
		getActivation: () => Activation,
		enableRunInBackground = true,
		defaultBackground = true,
		agentDiscovery?: AgentDiscoveryResult,
		backgroundProtocol: NonNullable<SubagentSettings["backgroundProtocol"]> = "legacy",
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
				backgroundProtocol === "mailbox-v2"
					? "Durably append a message to a direct mailbox-v2 child's FIFO mailbox without starting or resuming it."
					: "Queue a message as a direct continuable child's next FIFO turn. This returns acceptance, not the child's answer.",
			parameters: SendMessageParameters,
			execute: async (_id, params, signal) => {
				assertBackgroundControlEnabled("send_message");
				const activation = getActivation();
				const delivery = await this.sendMessageWithOutcome(
					this.parentForActivation(activation),
					params.subagent_id,
					params.message,
					signal,
				);
				return {
					content: [
						{
							type: "text",
							text:
								delivery.kind === "mailbox-v2"
									? `message ${delivery.messageId} durably enqueued for subagent ${params.subagent_id}; ${delivery.pendingMessages} pending`
									: `message queued as the next turn for subagent ${params.subagent_id}`,
						},
					],
					details: {
						kind: "control",
						action: "send",
						agentId: params.subagent_id,
						...(delivery.kind === "mailbox-v2"
							? {
									messageId: delivery.messageId,
									pendingMessages: delivery.pendingMessages,
								}
							: {}),
					} satisfies ControlDetails,
				};
			},
		});

		const followup = defineTool({
			name: "followup_task",
			label: "Follow-up Task",
			description:
				"Start exactly one scheduled turn for a direct mailbox-v2 child, atomically claiming its current pending FIFO mailbox batch.",
			parameters: FollowupTaskParameters,
			execute: async (_id, params, signal) => {
				assertBackgroundControlEnabled("followup_task");
				const activation = getActivation();
				const outcome = await this.followupTask(
					this.parentForActivation(activation),
					params.subagent_id,
					signal,
				);
				return {
					content: [
						{
							type: "text",
							text: `started turn ${outcome.turnId} for subagent ${params.subagent_id}, claiming ${outcome.claimedMessages} mailbox message${outcome.claimedMessages === 1 ? "" : "s"}`,
						},
					],
					details: {
						kind: "control",
						action: "followup",
						agentId: params.subagent_id,
						turnId: outcome.turnId,
						claimedMessages: outcome.claimedMessages,
					} satisfies ControlDetails,
				};
			},
		});

		const wait = defineTool({
			name: "wait_agent",
			label: "Wait Agent",
			description:
				"Wait event-driven for unread completion updates from direct mailbox-v2 children. This does not start a child or occupy a background scheduler slot.",
			parameters: WaitAgentParameters,
			execute: async (id, params, signal) => {
				assertBackgroundControlEnabled("wait_agent");
				const activation = getActivation();
				const outcome = await this.waitAgent(
					this.parentForActivation(activation),
					id,
					params.timeout_ms,
					signal,
				);
				return {
					content: [
						{
							type: "text",
							text: this.formatWaitAgentOutcome(outcome),
						},
					],
					details: {
						kind: "control",
						action: "wait",
						timedOut: outcome.timedOut,
						completionIds: outcome.updates.map(
							(update) => update.completionId,
						),
						unreadUpdates: outcome.unreadUpdates,
					} satisfies ControlDetails,
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
					details: { kind: "control", action: "interrupt", agentId: params.agent_id } satisfies ControlDetails,
				};
			},
		});

		const list = defineTool({
			name: "list_agents",
			label: "List Agents",
			description:
				"List direct continuable children or all descendants as running, idle, or ready, with separate mailbox task and completion counts.",
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
					details: { kind: "control", action: "report", agentId: activation.agentId } satisfies ControlDetails,
				};
			},
		});

		return [spawn, fork, send, followup, wait, interrupt, list, report];
	}

	outcomeToolResult(outcome: DelegationOutcome): AgentToolResult<DelegationDetails> {
		if (outcome.kind === "continuable") {
			return {
				content: [{ type: "text", text: `started subagent ${outcome.details.agentId}` }],
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
				if (entry.kind === "diagnostic") {
					return `${entry.piSessionId} [diagnostic: ${entry.reason}]`;
				}
				const location =
					scope === "descendants" ? ` parent=${entry.parentAgentId} depth=${entry.depth}` : "";
				const mailbox =
					entry.descriptor.runtime.backgroundProtocol === "mailbox-v2"
						? ` pending=${entry.pendingMessages} updates=${entry.unreadUpdates}`
						: "";
				return `${entry.agentId} [${entry.status}]${mailbox}${location} — ${entry.descriptor.label} (${entry.descriptor.agent.name})`;
			})
			.join("\n");
	}

	formatWaitAgentOutcome(outcome: WaitAgentOutcome): string {
		if (outcome.timedOut) {
			return `wait_agent timed out after ${outcome.timeoutMs}ms with no completion updates`;
		}
		const updates = outcome.updates.map((update) => {
			const output = update.output.trim() || "(no output)";
			const truncation = update.outputTruncated
				? `\n[Completion output truncated${
						update.omittedBytes !== undefined
							? `; ${update.omittedBytes} bytes omitted`
							: ""
					}.]`
				: "";
			return [
				`completion ${update.completionId}`,
				`child=${update.childAgentId} turn=${update.turnId} stop=${update.stopReason}`,
				`${output}${truncation}`,
			].join("\n");
		});
		if (outcome.unreadUpdates > 0) {
			updates.push(
				`${outcome.unreadUpdates} additional completion update${outcome.unreadUpdates === 1 ? "" : "s"} remain unread`,
			);
		}
		return updates.join("\n\n");
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
			makeRuntimeSettings(descriptor),
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
			descriptor.runtime.backgroundProtocol,
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
		const extensionFactories: InlineExtension[] =
			descriptor.runtime.openAIIdentity && isOpenAIResponsesModel(model)
				? [
						await loadCodexIdentityInlineExtension(
							options.parent.sessionManager,
						),
					]
				: [];

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
					extensionFactories,
					extensionsOverride: (base) => ({
						...base,
						extensions: base.extensions.filter(
							(extension) =>
								extension.resolvedPath.startsWith("<inline:")
								|| !isPathInside(this.packageRoot, extension.resolvedPath),
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
					if (
						descriptor.runtime.backgroundProtocol !== "mailbox-v2"
						&& (
							tool === "followup_task"
							|| tool === "wait_agent"
						)
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
				agentId: descriptor.agentId,
				runId: uuidv7(),
				descriptor,
				parent: options.parent,
				runtime,
				seedMessageCount: options.prepared.seedMessageCount,
				epochMessageStart: runtime.session.messages.length,
				controlState: createAgentControlState(),
				trace: [],
				streamedText: "",
				usage: emptyUsage(),
				startedTurnIds: new Set(),
				pendingMailboxClaims: new Set(),
				userMessageGates: new Map(),
				ownedChildren: new Set(),
				onUpdate: options.onUpdate,
				published: false,
				suppressSettlement: false,
				finalizing: false,
				holdsBackgroundSlot: false,
				persistenceGate: createPersistenceGate(
					runtime.session.sessionManager,
				),
				disposed: false,
			};
			const existing = this.active.get(activation.agentId);
			if (existing && !existing.disposed) {
				throw new Error(`subagent ${activation.agentId} already has a resident runtime`);
			}
			activation.unsubscribe = runtime.session.subscribe((event) => this.observe(activation!, event));
			this.active.set(activation.agentId, activation);
			return activation;
		} catch (error) {
			await runtime.dispose().catch(() => {});
			throw error;
		}
	}

	private async acquireBackgroundRun(
		activation: Activation,
		signal: AbortSignal | undefined,
		waitForCapacity: boolean,
	): Promise<BackgroundRunPermit | undefined> {
		if (activation.descriptor.mode !== "continuable") return undefined;
		const permit = await this.backgroundRuns.acquire({
			...(signal ? { signal } : {}),
			waitForCapacity,
		});
		activation.holdsBackgroundSlot = true;
		return permit;
	}

	private startPrompt(
		activation: Activation,
		prompt: string,
		signal: AbortSignal | undefined,
		options: StartPromptOptions,
	): { turnId: string; accepted: Promise<void>; result: Promise<SubagentRunResult> } {
		if (activation.currentRun) throw new Error(`subagent ${activation.agentId} is already running`);
		if (signal?.aborted) throw signal.reason ?? new Error("subagent start aborted");
		activation.pendingSettlement = undefined;
		this.resetTurnCapture(activation);
		const turnId = uuidv7();
		queueAgentTurn(activation.controlState, turnId);
		this.emitUpdate(activation);

		let resolveAccepted!: () => void;
		let rejectAccepted!: (error: Error) => void;
		let acceptedSettled = false;
		const accepted = new Promise<void>((resolvePromise, rejectPromise) => {
			resolveAccepted = resolvePromise;
			rejectAccepted = rejectPromise;
		});
		activation.currentMessageGate = accepted;
		const clearCurrentMessageGate = () => {
			if (activation.currentMessageGate === accepted) {
				activation.currentMessageGate = undefined;
			}
		};
		void accepted.then(clearCurrentMessageGate, clearCurrentMessageGate);
		const turnAbortController = new AbortController();
		activation.turnAbortController = turnAbortController;
		const abort = () => {
			turnAbortController.abort(
				signal?.reason ?? new Error(`subagent turn ${turnId} was aborted`),
			);
			void activation.runtime.session.abort().catch(() => {});
		};
		if (signal) signal.addEventListener("abort", abort, { once: true });
		let preflightSucceeded = false;
		const acceptPrompt = () => {
			if (acceptedSettled) return;
			if (turnAbortController.signal.aborted) {
				throw abortReason(turnAbortController.signal);
			}
			acceptedSettled = true;
			activation.userMessageGates.delete(turnId);
			this.publish(activation);
			if (options.detachAtAcceptance && signal) {
				signal.removeEventListener("abort", abort);
			}
			resolveAccepted();
		};
		const rejectPrompt = (error: Error) => {
			if (acceptedSettled) return;
			acceptedSettled = true;
			activation.userMessageGates.delete(turnId);
			if (!activation.published) {
				activation.suppressSettlement = true;
			}
			rejectAccepted(error);
		};
		if (options.acceptAfterUserMessage) {
			activation.userMessageGates.set(turnId, {
				prepare: () => {
					if (turnAbortController.signal.aborted) {
						throw abortReason(turnAbortController.signal);
					}
					options.onPromptAccepted?.(turnId);
				},
				accept: acceptPrompt,
				reject: rejectPrompt,
			});
		}

		const core = (async (): Promise<SubagentRunResult> => {
			let permit: BackgroundRunPermit | undefined;
			try {
				permit = await this.acquireBackgroundRun(
					activation,
					turnAbortController.signal,
					options.waitForCapacity,
				);
				if (turnAbortController.signal.aborted) {
					throw abortReason(turnAbortController.signal);
				}
				const preparedPrompt = options.preparePrompt
					? options.preparePrompt(turnId)
					: prompt;
				startAgentTurn(activation.controlState, turnId);
				activation.startedTurnIds.add(turnId);
				this.emitTurnStart(activation, turnId);
				this.emitUpdate(activation);
				await activation.runtime.session.prompt(preparedPrompt, {
					...(options.preparePrompt
						? {
								expandPromptTemplates: false,
								source: "extension" as const,
							}
						: {}),
					preflightResult: (success) => {
						if (acceptedSettled) return;
						if (success) {
							preflightSucceeded = true;
							if (options.acceptAfterUserMessage) {
								return;
							}
							options.onPromptAccepted?.(turnId);
							acceptPrompt();
						} else {
							rejectPrompt(
								new Error("subagent prompt was rejected before acceptance"),
							);
						}
					},
				});
				if (!acceptedSettled) {
					if (options.acceptAfterUserMessage && preflightSucceeded) {
						throw new Error(
							"subagent mailbox prompt was handled before a user turn started",
						);
					}
					if (turnAbortController.signal.aborted) {
						throw abortReason(turnAbortController.signal);
					}
					options.onPromptAccepted?.(turnId);
					acceptPrompt();
				}
				return this.collectResult(activation, turnId, "completed");
			} catch (error) {
				activation.lastError = errorText(error);
				if (!acceptedSettled) {
					rejectPrompt(
						error instanceof Error ? error : new Error(String(error)),
					);
				}
				const fallback = turnAbortController.signal.aborted ? "aborted" : "error";
				const result = this.collectResult(activation, turnId, fallback);
				if (!result.output) result.output = activation.lastError;
				return result;
			} finally {
				activation.userMessageGates.delete(turnId);
				if (signal) signal.removeEventListener("abort", abort);
				if (activation.turnAbortController === turnAbortController) {
					activation.turnAbortController = undefined;
				}
				if (permit) {
					activation.holdsBackgroundSlot = false;
					permit.release();
				}
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
		return { turnId, accepted, result: lifecycle };
	}

	private startInternalMessage(
		activation: Activation,
		customType: string,
		content: string,
		details: ParentMessageDetails,
	): void {
		if (activation.currentRun || activation.disposed) return;
		activation.pendingSettlement = undefined;
		this.resetTurnCapture(activation);
		const turnId = uuidv7();
		queueAgentTurn(activation.controlState, turnId);
		this.emitUpdate(activation);
		const turnAbortController = new AbortController();
		activation.turnAbortController = turnAbortController;
		let resolveMessageGate!: () => void;
		let rejectMessageGate!: (error: Error) => void;
		let messageGateSettled = false;
		const messageGate = new Promise<void>((resolvePromise, rejectPromise) => {
			resolveMessageGate = resolvePromise;
			rejectMessageGate = rejectPromise;
		});
		activation.currentMessageGate = messageGate;
		void messageGate.catch(() => {});
		const core = (async (): Promise<SubagentRunResult> => {
			let permit: BackgroundRunPermit | undefined;
			try {
				permit = await this.acquireBackgroundRun(
					activation,
					turnAbortController.signal,
					true,
				);
				startAgentTurn(activation.controlState, turnId);
				activation.startedTurnIds.add(turnId);
				this.emitTurnStart(activation, turnId);
				this.emitUpdate(activation);
				messageGateSettled = true;
				resolveMessageGate();
				await activation.runtime.session.sendCustomMessage(
					{ customType, content, display: true, details },
					{ triggerTurn: true, deliverAs: "followUp" },
				);
				return this.collectResult(activation, turnId, "completed");
			} catch (error) {
				activation.lastError = errorText(error);
				if (!messageGateSettled) {
					messageGateSettled = true;
					rejectMessageGate(
						error instanceof Error ? error : new Error(String(error)),
					);
				}
				const result = this.collectResult(
					activation,
					turnId,
					turnAbortController.signal.aborted ? "aborted" : "error",
				);
				if (!result.output) result.output = activation.lastError;
				return result;
			} finally {
				if (activation.turnAbortController === turnAbortController) {
					activation.turnAbortController = undefined;
				}
				if (activation.currentMessageGate === messageGate) {
					activation.currentMessageGate = undefined;
				}
				if (permit) {
					activation.holdsBackgroundSlot = false;
					permit.release();
				}
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
	}

	private async runFinished(activation: Activation, result: SubagentRunResult): Promise<void> {
		activation.pendingMailboxClaims.delete(result.turnId);
		activation.persistenceGate.reject(
			new Error(
				`subagent ${activation.agentId} ended before its session became durable`,
			),
		);
		finishAgentTurn(activation.controlState, result.turnId, result.stopReason);
		if (result.stopReason !== "completed") {
			activation.runtime.session.clearQueue();
		}
		const turnStarted = activation.startedTurnIds.delete(result.turnId);
		if (turnStarted) {
			this.emitTurnEnd(activation, result);
		}
		activation.pendingSettlement = result;
		if (
			turnStarted
			&& activation.published
			&& activation.descriptor.mode === "continuable"
			&& activation.descriptor.runtime.backgroundProtocol === "mailbox-v2"
		) {
			try {
				appendCompletionUpdate(activation.parent.sessionManager, {
					parentAgentId: activation.descriptor.parentAgentId,
					childAgentId: activation.agentId,
					result,
				});
			} catch (error) {
				activation.lastError = errorText(error);
				let durableFallback = false;
				try {
					appendUndeliveredCompletion(
						activation.runtime.session.sessionManager,
						{
							parentAgentId:
								activation.descriptor.parentAgentId,
							childAgentId: activation.agentId,
							result,
							error: activation.lastError,
						},
					);
					durableFallback = true;
				} catch {
					// The explicit event below remains the final observable path
					// when both parent delivery and child fallback persistence fail.
				}
				this.pi.events.emit("pi-subagent:completion-error", {
					runId: activation.runId,
					turnId: result.turnId,
					agentId: activation.agentId,
					parentAgentId: activation.descriptor.parentAgentId,
					error: activation.lastError,
					durableFallback,
				});
			}
			this.completionWaiters
				.get(completionWaiterKey(activation.parent))
				?.wake();
		}
		this.emitUpdate(activation, result);
		if (activation.descriptor.mode === "one-shot") {
			this.emitEnd(activation, result);
			return;
		}
		if (activation.suppressSettlement || this.draining) return;
		if (activation.ownedChildren.size > 0) {
			this.emitUpdate(activation, result);
			return;
		}
		await this.finalizeContinuable(activation);
	}

	private async finalizeContinuable(activation: Activation): Promise<void> {
		await this.agentOperations.run(activation.agentId, () =>
			this.finalizeContinuableLocked(activation),
		);
	}

	private async finalizeContinuableLocked(activation: Activation): Promise<void> {
		if (activation.finalizing || activation.disposed || activation.currentRun) return;
		const result = activation.pendingSettlement;
		if (!result || activation.ownedChildren.size > 0) return;
		activation.finalizing = true;
		activation.finalizePromise = (async () => {
			if (
				activation.descriptor.runtime.backgroundProtocol !== "mailbox-v2"
				&& !activation.suppressSettlement
				&& !this.draining
			) {
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
		const content = `Background subagent ${activation.agentId} ${stopReasonHeadline(result.stopReason)} and will do no further work unless you send it more.\n\n${closing}${
			truncated.truncated ? `\n\n[Closing message truncated; ${truncated.omittedBytes} bytes omitted.]` : ""
		}`;
		await activation.parent.deliver(
			SETTLED_CUSTOM_TYPE,
			content,
			{
				kind: "settled",
				childAgentId: activation.agentId,
				label: activation.descriptor.label,
				stopReason: result.stopReason,
				...(truncated.truncated ? { truncated: true } : {}),
			},
			"wakeup",
		);
	}

	private parentForActivation(activation: Activation): ParentRef {
		return {
			agentId: activation.agentId,
			depth: activation.descriptor.depth,
			cwd: activation.descriptor.cwd,
			sessionManager: activation.runtime.session.sessionManager,
			modelRuntime: activation.parent.modelRuntime,
			model: activation.runtime.session.model,
			thinkingLevel: activation.runtime.session.thinkingLevel,
			projectTrusted: activation.parent.projectTrusted,
			activation,
			deliver: async (customType, content, details, delivery) => {
				if (activation.disposed) throw new Error(`parent subagent ${activation.agentId} is no longer resident`);
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

	private resetTurnCapture(activation: Activation): void {
		activation.epochMessageStart = activation.runtime.session.messages.length;
		activation.streamedText = "";
		activation.usage = emptyUsage();
	}

	private collectResult(
		activation: Activation,
		turnId: string,
		fallback: SubagentStopReason,
	): SubagentRunResult {
		const messages = activation.runtime.session.messages;
		const output = finalAssistantText(messages, activation.epochMessageStart, activation.streamedText);
		const stopReason = finalStopReason(messages, activation.epochMessageStart, fallback);
		const truncated = truncateUtf8(output, activation.descriptor.runtime.maxOutputBytes);
		const sessionFile = activation.runtime.session.sessionFile;
		return {
			agentId: activation.agentId,
			turnId,
			piSessionId: activation.runtime.session.sessionId,
			...(sessionFile ? { sessionFile } : {}),
			output: truncated.truncated
				? `${truncated.text}\n\n[Output truncated; ${truncated.omittedBytes} bytes omitted.${
						sessionFile ? ` Full output: ${sessionFile}` : " Full output remains in the active child session."
					}]`
				: truncated.text,
			...(truncated.truncated
				? {
						outputTruncated: true,
						omittedBytes: truncated.omittedBytes,
					}
				: {}),
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
		if (event.type === "agent_end") {
			void this.releaseWaitAgentDeliveries(
				this.parentForActivation(activation),
				"parent agent turn ended without a durable wait_agent result",
			).catch((error) => {
				activation.lastError = errorText(error);
			});
			return;
		}
		if (event.type !== "message_end") return;
		if (event.message.role === "user") {
			const turnId = currentAgentTurnId(activation.controlState);
			const gate = turnId
				? activation.userMessageGates.get(turnId)
				: undefined;
			if (turnId && gate) {
				try {
					gate.prepare();
					commitMailboxClaim(
						activation.runtime.session.sessionManager,
						turnId,
						event.message,
					);
					activation.pendingMailboxClaims.delete(turnId);
					gate.accept();
				} catch (error) {
					const failure =
						error instanceof Error ? error : new Error(String(error));
					activation.lastError = failure.message;
					gate.reject(failure);
					void activation.runtime.session.abort().catch(() => {});
				}
			}
			return;
		}
		if (event.message.role === "toolResult") {
			if (event.message.usage) addUsage(activation.usage, event.message.usage, false);
			return;
		}
		if (event.message.role !== "assistant") return;
		activation.persistenceGate.resolve();
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
			runId: activation.runId,
			agentId: activation.agentId,
			piSessionId: activation.runtime.session.sessionId,
			parentAgentId: activation.descriptor.parentAgentId,
			provider: activation.descriptor.provider,
			mode: activation.descriptor.mode,
		});
	}

	private emitEnd(activation: Activation, result: SubagentRunResult): void {
		if (!activation.published) return;
		this.pi.events.emit("pi-subagent:end", {
			runId: activation.runId,
			agentId: activation.agentId,
			piSessionId: activation.runtime.session.sessionId,
			parentAgentId: activation.descriptor.parentAgentId,
			provider: activation.descriptor.provider,
			mode: activation.descriptor.mode,
			stopReason: result.stopReason,
			output: result.output,
		});
	}

	private emitTurnStart(activation: Activation, turnId: string): void {
		this.pi.events.emit("pi-subagent:turn-start", {
			runId: activation.runId,
			turnId,
			agentId: activation.agentId,
			piSessionId: activation.runtime.session.sessionId,
			parentAgentId: activation.descriptor.parentAgentId,
			provider: activation.descriptor.provider,
			mode: activation.descriptor.mode,
		});
	}

	private emitTurnEnd(activation: Activation, result: SubagentRunResult): void {
		this.pi.events.emit("pi-subagent:turn-end", {
			runId: activation.runId,
			turnId: result.turnId,
			agentId: activation.agentId,
			piSessionId: activation.runtime.session.sessionId,
			parentAgentId: activation.descriptor.parentAgentId,
			provider: activation.descriptor.provider,
			mode: activation.descriptor.mode,
			stopReason: result.stopReason,
			output: result.output,
		});
	}

	private detailsOf(activation: Activation, result?: SubagentRunResult): DelegationDetails {
		return {
			kind: "delegation",
			agentId: activation.agentId,
			...(currentAgentTurnId(activation.controlState)
				? { turnId: currentAgentTurnId(activation.controlState) }
				: {}),
			piSessionId: activation.runtime.session.sessionId,
			provider: activation.descriptor.provider,
			mode: activation.descriptor.mode,
			agent: activation.descriptor.agent.name,
			label: activation.descriptor.label,
			depth: activation.descriptor.depth,
			status: delegationStatus(
				activation.controlState,
				activation.ownedChildren.size > 0,
			),
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
		const waiterKey = completionWaiterKey(
			this.parentForActivation(activation),
		);
		const waiter = this.completionWaiters.get(waiterKey);
		if (waiter) {
			this.removeCompletionWaiter(waiterKey, waiter);
			waiter.reject(
				new Error(
					`parent subagent ${activation.agentId} was disposed while wait_agent was pending`,
				),
			);
		}
		activation.persistenceGate.reject(
			new Error(
				`subagent ${activation.agentId} ended before its session became durable`,
			),
		);
		setAgentResidency(activation.controlState, "unloaded");
		if (activation.descriptor.mode === "one-shot") closeAgent(activation.controlState);
		activation.unsubscribe?.();
		activation.unsubscribe = undefined;
		if (!activation.runtime.session.isIdle) await activation.runtime.session.abort().catch(() => {});
		try {
			await activation.runtime.dispose();
		} finally {
			if (this.active.get(activation.agentId) === activation) this.active.delete(activation.agentId);
		}
	}

	private async releaseParentOwnership(activation: Activation): Promise<void> {
		const owner = activation.parent.activation;
		if (!owner) return;
		owner.ownedChildren.delete(activation.agentId);
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
		if (descriptor.parentAgentId !== parent.agentId) {
			throw new Error(
				`subagent ${descriptor.label} is not a direct child of ${parent.agentId}`,
			);
		}
	}

	private assertContinuableDirectChild(
		parent: ParentRef,
		descriptor: SubagentDescriptor,
	): void {
		if (descriptor.mode !== "continuable") {
			throw new Error(
				`subagent ${descriptor.agentId} is one-shot and cannot accept follow-up work`,
			);
		}
		this.assertDirectParent(parent, descriptor);
	}

	private async findPersistedChild(
		parent: ParentRef,
		childId: string,
	): Promise<{ descriptor: SubagentDescriptor; sessionFile: string } | undefined> {
		const catalog = await readPersistedCatalog(parent.sessionManager);
		const entry = catalog.descriptors.find((candidate) => candidate.agentId === childId);
		return entry ? { descriptor: entry.descriptor, sessionFile: entry.sessionFile } : undefined;
	}

	private async catalogRecords(parent: ParentRef): Promise<CoordinatorCatalog> {
		const persisted = await readPersistedCatalog(parent.sessionManager);
		const records = new Map<string, CatalogRecord>();
		for (const item of persisted.descriptors) {
			records.set(item.agentId, {
				agentId: item.agentId,
				descriptor: item.descriptor,
				sessionFile: item.sessionFile,
				pendingMessages: item.pendingMessages,
				unreadUpdatesByChild: new Map(item.unreadUpdatesByChild),
			});
		}
		const activeSessionIds = new Set(
			[...this.active.values()].map((activation) => activation.runtime.session.sessionId),
		);
		const activeDiagnostics: CatalogEntry[] = [];
		const rootCompletions = foldCompletionMailbox(
			parent.sessionManager.getEntries(),
			{ parentAgentId: parent.agentId },
		);
		const rootUnreadUpdatesByChild =
			rootCompletions.kind === "valid"
				? unreadCompletionCounts(rootCompletions.snapshot)
				: new Map<string, number>();
		if (rootCompletions.kind === "corrupt") {
			const parentFile = parent.sessionManager.getSessionFile();
			activeDiagnostics.push({
				kind: "diagnostic",
				piSessionId: parent.sessionManager.getSessionId(),
				reason: "corrupt",
				...(parentFile
					? {
							sessionFile: parentFile,
							parentSessionFile: parentFile,
						}
					: {}),
				message: `corrupt completion mailbox: ${rootCompletions.message}`,
			});
		}
		for (const activation of this.active.values()) {
			if (activation.descriptor.cwd !== parent.cwd) continue;
			let pendingMessages = 0;
			if (activation.descriptor.runtime.backgroundProtocol === "mailbox-v2") {
				const mailbox = foldOwnedMailbox(
					activation.runtime.session.sessionManager.getEntries(),
					mailboxOwner(activation.descriptor),
				);
				if (mailbox.kind === "valid") {
					pendingMessages = mailbox.snapshot.pending.length;
				} else {
					activeDiagnostics.push({
						kind: "diagnostic",
						piSessionId: activation.runtime.session.sessionId,
						reason: "corrupt",
						...(activation.runtime.session.sessionFile
							? { sessionFile: activation.runtime.session.sessionFile }
							: {}),
						...(activation.descriptor.parentSessionFile
							? { parentSessionFile: activation.descriptor.parentSessionFile }
							: {}),
						message: `corrupt subagent mailbox: ${mailbox.message}`,
					});
					continue;
				}
			}
			const completions = foldCompletionMailbox(
				activation.runtime.session.sessionManager.getEntries(),
				{ parentAgentId: activation.agentId },
			);
			if (completions.kind === "corrupt") {
				activeDiagnostics.push({
					kind: "diagnostic",
					piSessionId: activation.runtime.session.sessionId,
					reason: "corrupt",
					...(activation.runtime.session.sessionFile
						? { sessionFile: activation.runtime.session.sessionFile }
						: {}),
					...(activation.descriptor.parentSessionFile
						? { parentSessionFile: activation.descriptor.parentSessionFile }
						: {}),
					message: `corrupt completion mailbox: ${completions.message}`,
				});
				continue;
			}
			records.set(activation.agentId, {
				agentId: activation.agentId,
				descriptor: activation.descriptor,
				...(activation.runtime.session.sessionFile
					? { sessionFile: activation.runtime.session.sessionFile }
					: {}),
				active: activation,
				pendingMessages,
				unreadUpdatesByChild: unreadCompletionCounts(
					completions.snapshot,
				),
			});
		}
		return {
			records: [...records.values()],
			diagnostics: [
				...persisted.diagnostics.filter(
					(diagnostic) => !activeSessionIds.has(diagnostic.piSessionId),
				),
				...activeDiagnostics,
			],
			rootUnreadUpdatesByChild,
		};
	}

	private distanceFrom(
		rootId: string,
		descriptor: SubagentDescriptor,
		byId: Map<string, CatalogRecord>,
	): number | undefined {
		let parentId = descriptor.parentAgentId;
		let distance = 1;
		const visited = new Set<string>();
		while (true) {
			if (parentId === rootId) return distance;
			if (visited.has(parentId)) return undefined;
			visited.add(parentId);
			const parent = byId.get(parentId);
			if (!parent) return undefined;
			parentId = parent.descriptor.parentAgentId;
			distance++;
		}
	}

	private async isDescendantOf(parent: ParentRef, descriptor: SubagentDescriptor): Promise<boolean> {
		const { records } = await this.catalogRecords(parent);
		const byId = new Map(records.map((record) => [record.agentId, record]));
		return this.distanceFrom(parent.agentId, descriptor, byId) !== undefined;
	}
}

export {
	REPORT_CUSTOM_TYPE,
	SETTLED_CUSTOM_TYPE,
	AGENT_CUSTOM_TYPE,
	LINEAGE_CUSTOM_TYPE,
};
