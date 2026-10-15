import type { AgentRecord, AgentStatus } from "./types.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { MarkdownTransformer, MessageRenderer, ToolRenderers } from "@earendil-works/pi-coding-agent";

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
	/** Bounded, plain-text content shown below the activity heading. */
	preview?: string;
}

export interface DashboardAgent {
	path: string;
	parentPath: string;
	type: string;
	model: string;
	thinkingLevel: string;
	lifecycle: AgentRecord["lifecycle"];
	lastResponse?: AgentRecord["lastResponse"];
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
	/** Reads only the selected agent; never starts or retains a child runtime. */
	getTranscript?(path: string, before?: string): TranscriptSnapshot;
	subscribe(listener: () => void): () => void;
}

export interface TranscriptEntry {
	id: string;
	timestamp: number;
	kind: "assistant" | "user" | "tool" | "notice";
	status: DashboardActivity["status"];
	text?: string;
	/** Sanitized structured message; not a replay or model-context value. */
	message?: AgentMessage;
	toolName?: string;
	/** Original bounded, opaque call ID for native renderer context; id is the UI cache key. */
	toolCallId?: string;
	args?: Record<string, unknown>;
	/** False only while an assistant is streaming an unfinished tool call. */
	argsComplete?: boolean;
	result?: {
		content: { type: "text"; text: string }[];
		details?: Record<string, unknown>;
		isError: boolean;
		durationMs?: number;
	};
	parentToolCallId?: string;
	streaming?: boolean;
	truncated?: boolean;
}

export interface TranscriptSnapshot {
	path: string;
	status: AgentStatus;
	entries: TranscriptEntry[];
	inheritedCount: number;
	/** Cursor for the previous page; absent when the owned history is exhausted. */
	before?: string;
	error?: string;
	closed?: boolean;
	presentation?: TranscriptPresentation;
}

/** Weak, display-only resolver access; never owns a child session. */
export interface TranscriptPresentation {
	cwd: string;
	revision: string;
	outputPad: number;
	resolveTool(name: string, fallback?: ToolRenderers): ToolRenderers | undefined;
	resolveMessage(customType: string): MessageRenderer | undefined;
	markdownTransformers: readonly MarkdownTransformer[];
}
