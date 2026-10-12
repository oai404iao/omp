import type { AgentStatus } from "./types.ts";

/** Read-only UI data; never a model-facing tool contract. */
export interface DashboardUsage {
	available: boolean;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning?: number;
	totalTokens: number;
	/** Provider-reported estimate; null when a price is unavailable. */
	cost: number | null;
	requests: number;
	tools: number;
	nestedTools: number;
	nestedToolsPartial: boolean;
}

export interface DashboardContext {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
	timestamp: number;
	live: boolean;
}

export interface DashboardActivity {
	id: string;
	timestamp: number;
	kind: "tool" | "response" | "task" | "message" | "run" | "compaction" | "retry";
	status: "running" | "success" | "error" | "interrupted" | "info";
	label: string;
	summary: string;
}

export interface DashboardAgent {
	path: string;
	parentPath: string;
	type: string;
	model: string;
	thinkingLevel: string;
	createdAt: string;
	status: AgentStatus;
	topic: string;
	task: string;
	error?: string;
	dataError?: string;
	usage: DashboardUsage;
	context?: DashboardContext;
	/** Settled run durations, excluding the currently active interval. */
	durationMs?: number;
	durationPartial: boolean;
	activeSince?: number;
	activity: DashboardActivity[];
}

export interface DashboardSnapshot {
	agents: DashboardAgent[];
	activeCount: number;
	maxConcurrentAgents: number;
	closed?: boolean;
	error?: string;
}

export interface DashboardSource {
	getSnapshot(): DashboardSnapshot;
	subscribe(listener: () => void): () => void;
}
