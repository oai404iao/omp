import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";

export const DESCRIPTOR_VERSION = 5;
export type AgentScope = "user" | "project" | "both";
export type AgentSource = "user" | "project";
export type ForkTurns = "all" | "none";
export type AgentStatus = "pending_init" | "running" | "completed" | "interrupted" | "errored";
export type SubagentStopReason = "completed" | "aborted" | "error" | "max-tokens";

export interface SubagentSettings {
	agentScope: AgentScope;
	maxDepth: number;
	maxConcurrentAgents: number;
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

export type AgentSnapshot = Omit<AgentDefinition, "filePath">;
export interface SubagentUsage extends Usage { turns: number }

export interface SpawnInput {
	task_name: string;
	message: string;
	fork_turns?: ForkTurns;
	agent_type?: string;
}

export interface AgentDescriptor {
	version: typeof DESCRIPTOR_VERSION;
	id: string;
	path: string;
	parentPath: string;
	depth: number;
	cwd: string;
	createdAt: string;
	agent: AgentSnapshot;
	model: { provider: string; id: string };
	thinkingLevel: ThinkingLevel;
	forkTurns: ForkTurns;
	settings: SubagentSettings;
	/** Registration on the parent's canonical branch. */
	anchorId: string;
}

export interface MailMessage {
	id: string;
	from: string;
	to: string;
	kind: "message" | "task" | "completion";
	text: string;
	createdAt: string;
	runId?: string;
}

export interface AgentRecord {
	descriptor: AgentDescriptor;
	sessionFile: string;
	status: AgentStatus;
	runId?: string;
	error?: string;
	mailbox: MailMessage[];
	/** Completion retained here if the parent's bounded mailbox is full. */
	outbox?: MailMessage[];
}

export interface AgentListItem {
	agent_name: string;
	agent_status: AgentStatus;
}

export interface WaitResult {
	message: string;
	timed_out: boolean;
}

export function snapshotAgent(agent: AgentDefinition): AgentSnapshot {
	const { filePath: _, ...snapshot } = agent;
	return structuredClone(snapshot);
}
