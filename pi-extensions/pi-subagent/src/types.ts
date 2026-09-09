import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";

export type AgentScope = "user" | "project" | "both";
/** Sources that runtime discovery is allowed to activate. */
export type AgentSource = "user" | "project";
/** `bundled` is retained only for reading descriptors written by older releases. */
export type AgentSnapshotSource = AgentSource | "bundled";
export type ReportDelivery = "wakeup" | "quiet";
export type BackgroundProtocol = "legacy" | "mailbox-v2";
export type SubagentMode = "one-shot" | "continuable";
export type SubagentProviderName = "spawn" | "fork";
export type SubagentStopReason = "completed" | "aborted" | "error" | "max-tokens";
export type ContextInheritance =
	| { mode: "fresh" }
	| { mode: "all_completed" }
	| { mode: "last_n_completed"; completedTurns: number };

export interface SubagentTask {
	name: string;
	path: string;
}

export interface SubagentSettings {
	agentScope: AgentScope;
	maxDepth: number;
	enableRunInBackground: boolean;
	defaultBackground: boolean;
	maxConcurrentBackgroundRuns: number;
	maxIdleRuntimes: number;
	backgroundProtocol?: BackgroundProtocol;
	reportDelivery: ReportDelivery;
	inheritExtensions: boolean;
	openAIIdentity: boolean;
	maxOutputBytes: number;
}

export interface AgentDefinition {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinking?: ThinkingLevel;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

export interface AgentSnapshot {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinking?: ThinkingLevel;
	systemPrompt: string;
	source: AgentSnapshotSource;
}

export interface ResolvedModel {
	provider: string;
	id: string;
}

export interface SubagentRuntimeSnapshot {
	agentScope: AgentScope;
	maxDepth: number;
	enableRunInBackground: boolean;
	defaultBackground: boolean;
	maxConcurrentBackgroundRuns: number;
	maxIdleRuntimes: number;
	backgroundProtocol: BackgroundProtocol;
	reportDelivery: ReportDelivery;
	inheritExtensions: boolean;
	openAIIdentity: boolean;
	maxOutputBytes: number;
}

interface SubagentDescriptorBase {
	mode: SubagentMode;
	provider: SubagentProviderName;
	label: string;
	/** Durable pi-subagent control identity, independent of provider wire ids. */
	agentId: string;
	/** Durable control identity of the delegating pi-subagent. */
	parentAgentId: string;
	/** Pi session lookup key of the delegating agent; never used as a wire id. */
	parentPiSessionId: string;
	/** Path of the parent's session file at delegation time (attribute, not identity). */
	parentSessionFile?: string;
	depth: number;
	cwd: string;
	createdAt: string;
	agent: AgentSnapshot;
	model: ResolvedModel;
	thinkingLevel: ThinkingLevel;
	runtime: SubagentRuntimeSnapshot;
}

export interface SubagentDescriptorV2 extends SubagentDescriptorBase {
	version: 2;
}

export interface SubagentDescriptorV3 extends SubagentDescriptorBase {
	version: 3;
	task: SubagentTask;
	context: ContextInheritance;
}

export type SubagentDescriptor =
	| SubagentDescriptorV2
	| SubagentDescriptorV3;

export interface SubagentUsage extends Usage {
	turns: number;
}

export interface SubagentRunResult {
	agentId: string;
	turnId: string;
	piSessionId?: string;
	sessionFile?: string;
	output: string;
	outputTruncated?: boolean;
	omittedBytes?: number;
	stopReason: SubagentStopReason;
	usage: SubagentUsage;
}

export interface TraceItem {
	type: "tool" | "text";
	name?: string;
	text: string;
}

export interface DelegationDetails {
	kind: "delegation";
	agentId: string;
	taskPath: string;
	turnId?: string;
	piSessionId?: string;
	provider: SubagentProviderName;
	mode: SubagentMode;
	context: ContextInheritance;
	agent: string;
	label: string;
	depth: number;
	status: "starting" | "running" | "waiting" | "completed" | "failed" | "ready";
	sessionFile?: string;
	stopReason?: SubagentStopReason;
	output?: string;
	trace: TraceItem[];
	usage?: SubagentUsage;
}

export interface ControlDetails {
	kind: "control";
	action: "send" | "followup" | "wait" | "interrupt" | "list" | "report";
	agentId?: string;
	taskPath?: string;
	messageId?: string;
	turnId?: string;
	pendingMessages?: number;
	claimedMessages?: number;
	completionIds?: string[];
	timedOut?: boolean;
	unreadUpdates?: number;
}

export interface CatalogChild {
	kind: "child";
	agentId: string;
	parentAgentId: string;
	taskPath: string;
	parentTaskPath: string;
	depth: number;
	descriptor: SubagentDescriptor;
	sessionFile?: string;
	status: "running" | "idle" | "ready";
	pendingMessages: number;
	unreadUpdates: number;
}

export interface CatalogDiagnostic {
	kind: "diagnostic";
	piSessionId: string;
	reason: "corrupt" | "unavailable";
	sessionFile?: string;
	parentSessionFile?: string;
	message: string;
}

export type CatalogEntry = CatalogChild | CatalogDiagnostic;

export interface ParentMessageDetails {
	kind: "report" | "settled";
	childAgentId: string;
	taskPath?: string;
	label: string;
	stopReason?: SubagentStopReason;
	truncated?: boolean;
}

export function snapshotAgent(agent: AgentDefinition): AgentSnapshot {
	return {
		name: agent.name,
		description: agent.description,
		...(agent.tools ? { tools: [...agent.tools] } : {}),
		...(agent.model ? { model: agent.model } : {}),
		...(agent.thinking ? { thinking: agent.thinking } : {}),
		systemPrompt: agent.systemPrompt,
		source: agent.source,
	};
}
