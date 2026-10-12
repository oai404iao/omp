import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { DashboardActivity, DashboardContext } from "./dashboard-types.ts";
import type { AgentStatus } from "./types.ts";
import { readRunTelemetry, writeRunTelemetry } from "./telemetry-store.ts";

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
	return Array.from(stripTerminalSequences(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " "))
		.slice(0, limit).join("").trim();
}

/** Deliberately do not render shell commands, arbitrary arguments or results. */
export function toolSummary(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const value = args as Record<string, unknown>;
	const path = value.path ?? value.file_path;
	return typeof path === "string" ? dashboardText(path) : "";
}

export class AgentTelemetry {
	private readonly startedAt = Date.now();
	private readonly startedClock = performance.now();
	private readonly tools = new Set<string>();
	private readonly nestedTools = new Set<string>();
	private readonly activity = new Map<string, DashboardActivity>();
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
		while (this.activity.size > ACTIVITY_LIMIT) this.activity.delete(this.activity.keys().next().value!);
	}

	private readContext(live: boolean): void {
		this.context = undefined;
		this.safe(() => {
			const usage = this.session.getContextUsage();
			// Do not retain an obsolete model's limit when the current one is unknown.
			this.context = usage ? { ...usage, timestamp: Date.now(), live } : undefined;
		});
	}

	private observe(event: AgentSessionEvent): void {
		if (this.disposed || this.finished) return;
		const timestamp = Date.now();
		if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
			(event.parentToolCallId ? this.nestedTools : this.tools).add(event.toolCallId);
			const id = `tool:${event.toolCallId}`;
			this.put({
				id, timestamp, kind: "tool",
				status: event.type === "tool_execution_start" ? "running" : event.isError ? "error" : "success",
				label: dashboardText(event.toolName, 80),
				summary: event.type === "tool_execution_start" ? toolSummary(event.args) : this.activity.get(id)?.summary ?? "",
			});
		} else if (event.type === "message_end" && event.message.role === "assistant") {
			const message = event.message;
			if (message.stopReason !== "pending") this.put({
				id: `response:${this.runId}:${this.sequence++}`, timestamp: message.timestamp, kind: "response",
				status: message.stopReason === "error" ? "error" : message.stopReason === "aborted" ? "interrupted" : "success",
				label: "Response",
				summary: dashboardText(message.content.filter(item => item.type === "text").map(item => item.text).join(" ")),
			});
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
		this.safe(this.onChange);
	}

	snapshot(): TelemetrySnapshot {
		if (!this.finished && !this.disposed) this.readContext(true);
		return {
			runId: this.runId, ...(!this.finished ? { activeSince: this.startedAt } : {}),
			toolIds: [...this.tools], nestedToolIds: [...this.nestedTools],
			activity: [...this.activity.values()].map(item => ({ ...item })),
			...(this.context ? { context: { ...this.context } } : {}),
			timingPartial: this.timingPartial,
		};
	}

	finish(status: AgentStatus): void {
		if (this.finished) return;
		this.finished = true;
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
		this.safe(this.onChange);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.safe(() => this.unsubscribe?.());
		this.unsubscribe = undefined;
	}
}
