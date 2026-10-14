import type { AgentSessionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { TranscriptEntry } from "./dashboard-types.ts";
import type { AgentStatus } from "./types.ts";
import { TRANSCRIPT_BYTE_LIMIT, transcriptArgs, transcriptContent, transcriptIdentifier, transcriptMessage, transcriptResult, transcriptText } from "./transcript-text.ts";

/** Bounded transient display state; owns no runtime, subscriptions, files or timers. */
export class LiveTranscript {
	private readonly entries = new Map<string, TranscriptEntry>();
	private readonly finalized = new Map<string, WeakRef<object>>();
	private readonly settledTools = new Set<string>();
	private readonly finishedMessages = new WeakSet<object>();
	private readonly sizes = new Map<string, number>();
	private readonly provisionalTools = new Set<string>();
	private readonly executingTools = new Set<string>();
	private bytes = 0;
	private clipped = false;
	private sequence = 0;
	private assistantId?: string;
	private finished = false;

	private put(entry: TranscriptEntry): void {
		const size = Buffer.byteLength(JSON.stringify(entry));
		this.bytes += size - (this.sizes.get(entry.id) ?? 0);
		this.sizes.set(entry.id, size);
		this.entries.set(entry.id, entry);
		while (this.entries.size > 99 || this.bytes > TRANSCRIPT_BYTE_LIMIT - 512) {
			const oldest = this.entries.keys().next().value!;
			this.entries.delete(oldest);
			this.finalized.delete(oldest);
			this.executingTools.delete(oldest);
			this.provisionalTools.delete(oldest);
			this.bytes -= this.sizes.get(oldest) ?? 0;
			this.sizes.delete(oldest);
			this.clipped = true;
		}
	}

	observe(event: AgentSessionEvent): void {
		if (this.finished) return;
		if ((event.type === "message_start" || event.type === "message_update" || event.type === "message_end") &&
			event.message.role === "assistant") {
			const message = event.message;
			if (this.finishedMessages.has(message) || (event.type === "message_update" && !this.assistantId)) return;
			if (event.type === "message_start" || !this.assistantId) this.assistantId = `live:assistant:${this.sequence++}`;
			const id = this.assistantId;
			const tools = message.content.filter(block => block.type === "toolCall");
			const text = [transcriptContent(message.content.filter(block => block.type === "text")),
				message.errorMessage ? transcriptText(message.errorMessage) : ""].filter(Boolean).join("\n");
			const ended = event.type === "message_end";
			this.put({
				id, timestamp: message.timestamp, kind: "assistant", text,
				message: transcriptMessage(message),
				status: !ended ? "running" : message.stopReason === "error" ? "error" :
					message.stopReason === "aborted" ? "interrupted" : "success",
				streaming: !ended,
			});
			for (const tool of tools) {
				const toolId = `tool:${transcriptIdentifier(tool.id)}`;
				this.provisionalTools.add(toolId);
				if (this.entries.get(toolId)?.result) continue;
				this.put({
					id: toolId, timestamp: message.timestamp, kind: "tool", status: "running",
					toolCallId: transcriptIdentifier(tool.id),
					toolName: transcriptText(tool.name, 80), args: transcriptArgs(tool.arguments),
					argsComplete: ended,
				});
			}
			if (ended) {
				const accepted = new Set(tools.map(tool => `tool:${transcriptIdentifier(tool.id)}`));
				for (const toolId of this.provisionalTools) {
					if (accepted.has(toolId) || this.executingTools.has(toolId)) continue;
					this.entries.delete(toolId);
					this.bytes -= this.sizes.get(toolId) ?? 0;
					this.sizes.delete(toolId);
				}
				this.provisionalTools.clear();
				this.finalized.set(id, new WeakRef(message));
				this.finishedMessages.add(message);
				this.assistantId = undefined;
			}
		} else if (event.type === "tool_execution_start" || event.type === "tool_execution_update" ||
			event.type === "tool_execution_end") {
			const id = `tool:${transcriptIdentifier(event.toolCallId)}`;
			if (this.settledTools.has(id)) return;
			const previous = this.entries.get(id);
			const ended = event.type === "tool_execution_end";
			if (event.type === "tool_execution_start") this.executingTools.add(id);
			if (ended) {
				this.settledTools.add(id);
				while (this.settledTools.size > 256) this.settledTools.delete(this.settledTools.values().next().value!);
			}
			this.put({
				id, timestamp: previous?.timestamp ?? Date.now(), kind: "tool",
				toolCallId: transcriptIdentifier(event.toolCallId),
				toolName: transcriptText(event.toolName, 80),
				args: event.type === "tool_execution_start" ? transcriptArgs(event.args) : previous?.args ?? {},
				argsComplete: true,
				status: ended ? event.isError ? "error" : "success" : "running",
				streaming: !ended,
				...(event.parentToolCallId ? { parentToolCallId: transcriptIdentifier(event.parentToolCallId) } : {}),
				...(event.type === "tool_execution_update" ? { result: transcriptResult(event.partialResult, false) } :
					ended ? { result: transcriptResult(event.result, event.isError, event.durationMs) } : {}),
			});
		}
	}

	snapshot(branch: readonly SessionEntry[] = []): TranscriptEntry[] {
		const ids = new Map<object, string>();
		for (const entry of branch) if (entry.type === "message" && entry.message.role === "assistant") {
			ids.set(entry.message, entry.id);
		}
		const result = [...this.entries.values()].map(entry => {
			const message = this.finalized.get(entry.id)?.deref();
			const canonical = message && ids.get(message);
			return structuredClone(canonical ? { ...entry, id: `assistant:${canonical}` } : entry);
		});
		if (this.clipped) result.unshift({
			id: "notice:live-limit", kind: "notice", status: "info", timestamp: result[0]?.timestamp ?? 0,
			text: "Live display cache bounded; earlier nested output may be unavailable. Saved history can be paged separately.",
		});
		return result;
	}

	finish(status: AgentStatus): void {
		this.finished = true;
		for (const [id, entry] of this.entries) if (entry.status === "running") this.entries.set(id, {
			...entry, status: status === "interrupted" ? "interrupted" : "error", streaming: false,
		});
	}

	clear(): void {
		this.entries.clear(); this.finalized.clear(); this.settledTools.clear(); this.sizes.clear();
		this.provisionalTools.clear(); this.executingTools.clear();
		this.assistantId = undefined; this.bytes = 0; this.clipped = false;
	}
}
