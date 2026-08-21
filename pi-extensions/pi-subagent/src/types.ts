import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";

export type AgentScope = "user" | "project" | "both";
export type AgentSource = "bundled" | "user" | "project";
export type ReportDelivery = "wakeup" | "quiet";
export type SubagentMode = "one-shot" | "continuable";
export type SubagentProviderName = "spawn" | "fork";
export type SubagentStopReason = "completed" | "aborted" | "error" | "max-tokens";

export interface SubagentSettings {
	agentScope: AgentScope;
	syncBundledAgents: boolean;
	maxDepth: number;
	enableRunInBackground: boolean;
	defaultBackground: boolean;
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
	source: AgentSource;
}

export interface ResolvedModel {
	provider: string;
	id: string;
}

export interface SubagentRuntimeSnapshot {
	agentScope: AgentScope;
	syncBundledAgents: boolean;
	maxDepth: number;
	enableRunInBackground: boolean;
	defaultBackground: boolean;
	reportDelivery: ReportDelivery;
	inheritExtensions: boolean;
	openAIIdentity: boolean;
	maxOutputBytes: number;
}

export interface SubagentDescriptor {
	version: 2;
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

export interface SubagentUsage extends Usage {
	turns: number;
}

export interface SubagentRunResult {
	agentId: string;
	piSessionId?: string;
	sessionFile?: string;
	output: string;
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
	piSessionId?: string;
	provider: SubagentProviderName;
	mode: SubagentMode;
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
	action: "send" | "interrupt" | "list" | "report";
	agentId?: string;
}

export interface CatalogChild {
	kind: "child";
	agentId: string;
	parentAgentId: string;
	depth: number;
	descriptor: SubagentDescriptor;
	sessionFile?: string;
	status: "running" | "idle" | "ready";
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
