import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { DashboardActivity, DashboardContext, TranscriptEntry } from "./dashboard-types.ts";
import type { AgentStatus } from "./types.ts";
import { readRunTelemetry, writeRunTelemetry } from "./telemetry-store.ts";
import { responseActivity, toolActivity, toolResultActivity } from "./activity-preview.ts";
import { LiveTranscript } from "./transcript-live.ts";

export const TELEMETRY_CUSTOM_TYPE = "pi-subagent/telemetry-v1";
export const ACTIVITY_LIMIT = 50;

export interface TelemetrySnapshot {
	runId: string;
	activeSince?: number;
	toolIds: readonly string[];
	nestedToolIds: readonly string[];
	activity: readonly DashboardActivity[];
	context?: DashboardContext;
	timingPartial?: boolean;
}

export interface RunTelemetryEntry {
	version: 1;
	kind: "run-start" | "run-end";
	runId: string;
	startedAt: number;
	/** Actual transcript leaf at this boundary; never a synthetic entry. */
	anchorId?: string | null;
	timestamp?: number;
	durationMs?: number;
	status?: AgentStatus;
	context?: DashboardContext;
}

/** Never allow transcript text to inject terminal control sequences. */
export function dashboardText(text: string, limit = 160): string {
	return Array.from(stripTerminalSequences(text.slice(0, Math.max(4096, limit * 2))).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " "))
		.slice(0, limit).join("").trim();
}

export class AgentTelemetry {
	private readonly startedAt = Date.now();
	private readonly startedClock = performance.now();
	private readonly tools = new Set<string>();
	private readonly nestedTools = new Set<string>();
	private readonly activity = new Map<string, DashboardActivity>();
	private readonly transcript = new LiveTranscript();
	private readonly toolInputs = new Map<string, ReturnType<typeof toolActivity>>();
	private readonly settledTools = new Set<string>();
	private readonly finishedResponses = new Set<number>();
	private readonly completedMessages = new WeakSet<object>();
	private readonly finalizedMessages = new Map<string, WeakRef<object>>();
	private activeResponse?: { id: string };
	private streamRefresh?: ReturnType<typeof setTimeout>;
	private unsubscribe?: () => void;
	private finished = false;
	private disposed = false;
	private sequence = 0;
	private context?: DashboardContext;
	private records: RunTelemetryEntry[] = [];
	private sessionFile?: string;
	private timingPartial = true;
	private compactionId?: string;
	private previousCompactionId?: string;

	constructor(
		private readonly session: AgentSession,
		private readonly runId: string,
		private readonly onChange: () => void,
		private readonly onError: (error: unknown) => void,
	) {
		this.safe(() => {
			this.unsubscribe = session.subscribe(event => this.safe(() => this.observe(event)));
		});
		this.safe(() => {
			const file = session.sessionManager.getSessionFile();
			if (!file) { this.timingPartial = true; return; }
			const stored = readRunTelemetry(file);
			if (stored.error) {
				this.timingPartial = true;
				throw new Error(stored.error);
			}
			this.sessionFile = file;
			this.records = stored.records;
			this.timingPartial = false;
		});
		this.persist({ version: 1, kind: "run-start", runId, startedAt: this.startedAt });
	}

	private safe(action: () => void): void {
		try { action(); }
		catch (error) {
			try { this.onError(error); } catch { /* Observability never changes agent execution. */ }
		}
	}

	private persist(data: RunTelemetryEntry): void {
		if (!this.sessionFile) return;
		this.safe(() => {
			try {
				const next = [...this.records, {
					...data, anchorId: this.session.sessionManager.getLeafId(), timestamp: Date.now(),
				}];
				writeRunTelemetry(this.sessionFile!, next);
				this.records = next;
			} catch (error) {
				this.timingPartial = true;
				throw error;
			}
		});
	}

	private put(item: DashboardActivity): void {
		this.activity.delete(item.id);
		this.activity.set(item.id, item);
		while (this.activity.size > ACTIVITY_LIMIT) {
			const oldest = this.activity.keys().next().value!;
			this.activity.delete(oldest);
			this.finalizedMessages.delete(oldest);
		}
	}

	private readContext(live: boolean): void {
		this.context = undefined;
		this.safe(() => {
			const usage = this.session.getContextUsage();
			// Do not retain an obsolete model's limit when the current one is unknown.
			this.context = usage ? { ...usage, timestamp: Date.now(), live } : undefined;
		});
	}

	private notify(streaming = false): void {
		if (!streaming) {
			clearTimeout(this.streamRefresh);
			this.streamRefresh = undefined;
			this.safe(this.onChange);
		} else if (!this.streamRefresh) {
			this.streamRefresh = setTimeout(() => {
				this.streamRefresh = undefined;
				if (!this.disposed && !this.finished) this.safe(this.onChange);
			}, 100);
			this.streamRefresh.unref();
		}
	}

	private observe(event: AgentSessionEvent): void {
		if (this.disposed || this.finished) return;
		this.safe(() => this.transcript.observe(event));
		const timestamp = Date.now();
		let streaming = false;
		if (event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end") {
			if (event.type !== "tool_execution_end" && this.settledTools.has(event.toolCallId)) return;
			(event.parentToolCallId ? this.nestedTools : this.tools).add(event.toolCallId);
			const id = `tool:${event.toolCallId}`;
			if (event.type === "tool_execution_start" || !this.toolInputs.has(id)) {
				this.toolInputs.set(id, toolActivity(event.toolName, event.type === "tool_execution_end" ? undefined : event.args));
				while (this.toolInputs.size > ACTIVITY_LIMIT) this.toolInputs.delete(this.toolInputs.keys().next().value!);
			}
			const input = this.toolInputs.get(id)!;
			const content = event.type === "tool_execution_start" ? input :
				toolResultActivity(input, event.type === "tool_execution_end" ? event.result : event.partialResult,
					event.type === "tool_execution_end" && event.isError);
			this.put({
				id, timestamp: event.type === "tool_execution_update" ? this.activity.get(id)?.timestamp ?? timestamp : timestamp, kind: "tool",
				status: event.type !== "tool_execution_end" ? "running" : event.isError ? "error" : "success",
				label: dashboardText(event.toolName, 80),
				...content,
			});
			if (event.type === "tool_execution_end") this.settledTools.add(event.toolCallId);
			streaming = event.type === "tool_execution_update";
		} else if ((event.type === "message_start" || event.type === "message_update" || event.type === "message_end") &&
			event.message.role === "assistant") {
			const message = event.message;
			if (event.type === "message_end" && (message.stopReason === "pending" || this.completedMessages.has(message))) return;
			if (event.type === "message_update" && !this.activeResponse && this.finishedResponses.has(message.timestamp)) return;
			if (!this.activeResponse) this.activeResponse = {
				id: `response:${this.runId}:${this.sequence++}`,
			};
			this.put({
				id: this.activeResponse.id, timestamp: message.timestamp, kind: "response",
				status: event.type !== "message_end" ? "running" : message.stopReason === "error" ? "error" :
					message.stopReason === "aborted" ? "interrupted" : "success",
				label: "Response",
				...responseActivity(message),
			});
			if (event.type === "message_end") {
				this.completedMessages.add(message);
				this.finalizedMessages.set(this.activeResponse.id, new WeakRef(message));
				this.finishedResponses.add(message.timestamp);
				while (this.finishedResponses.size > ACTIVITY_LIMIT) this.finishedResponses.delete(this.finishedResponses.keys().next().value!);
				this.activeResponse = undefined;
			}
			streaming = event.type === "message_update";
		} else if (event.type === "compaction_start" || event.type === "compaction_end") {
			const lastCompaction = [...this.session.sessionManager.getBranch()].reverse().find(entry => entry.type === "compaction");
			if (event.type === "compaction_start") {
				this.previousCompactionId = lastCompaction?.id;
				this.compactionId = `compaction:${this.runId}:${this.sequence++}`;
			} else if (!event.aborted && !event.errorMessage && lastCompaction && lastCompaction.id !== this.previousCompactionId) {
				if (this.compactionId) this.activity.delete(this.compactionId);
				this.compactionId = `compaction:${lastCompaction.id}`;
			}
			this.put({
				id: this.compactionId ?? `compaction:${this.runId}:${this.sequence++}`, timestamp, kind: "compaction", label: "Compaction",
				status: event.type === "compaction_start" ? "running" : event.aborted ? "interrupted" :
					event.errorMessage ? "error" : "success",
				summary: event.reason,
			});
		} else if (event.type === "auto_retry_start" || event.type === "auto_retry_end") {
			this.put({
				id: `retry:${this.runId}:${event.attempt}`, timestamp, kind: "retry", label: "Retry",
				status: event.type === "auto_retry_start" ? "running" : event.success ? "success" : "error",
				summary: `Attempt ${event.attempt}`,
			});
		} else if (event.type !== "message_end" && event.type !== "entry_appended") return;
		this.notify(streaming);
	}

	transcriptSnapshot(): TranscriptEntry[] { return this.transcript.snapshot(this.session.sessionManager.getBranch()); }

	snapshot(): TelemetrySnapshot {
		if (!this.finished && !this.disposed) this.readContext(true);
		const ids = new Map<object, string>();
		this.safe(() => {
			for (const entry of this.session.sessionManager.getBranch?.() ?? []) {
				if (entry.type === "message" && entry.message.role === "assistant") ids.set(entry.message, entry.id);
			}
		});
		return {
			runId: this.runId, ...(!this.finished ? { activeSince: this.startedAt } : {}),
			toolIds: [...this.tools], nestedToolIds: [...this.nestedTools],
			activity: [...this.activity.values()].map(item => {
				const message = this.finalizedMessages.get(item.id)?.deref();
				const canonical = message && ids.get(message);
				return { ...item, ...(canonical ? { id: `response:${canonical}` } : {}) };
			}),
			...(this.context ? { context: { ...this.context } } : {}),
			timingPartial: this.timingPartial,
		};
	}

	finish(status: AgentStatus): void {
		if (this.finished) return;
		this.finished = true;
		this.safe(() => this.transcript.finish(status));
		this.readContext(false);
		for (const [id, item] of this.activity) {
			if (item.status === "running") this.activity.set(id, {
				...item, status: status === "interrupted" ? "interrupted" : "error",
			});
		}
		this.persist({
			version: 1, kind: "run-end", runId: this.runId, startedAt: this.startedAt,
			durationMs: Math.max(0, performance.now() - this.startedClock), status,
			...(this.context ? { context: this.context } : {}),
		});
		this.notify();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		clearTimeout(this.streamRefresh);
		this.streamRefresh = undefined;
		this.transcript.clear();
		this.toolInputs.clear();
		this.finalizedMessages.clear();
		this.safe(() => this.unsubscribe?.());
		this.unsubscribe = undefined;
	}
}
