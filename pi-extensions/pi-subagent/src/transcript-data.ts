import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { TranscriptEntry, TranscriptSnapshot } from "./dashboard-types.ts";
import { DESCRIPTOR_CUSTOM_TYPE } from "./store.ts";
import type { AgentRecord } from "./types.ts";
import { boundTranscript, transcriptArgs, transcriptContent, transcriptIdentifier, transcriptMessage, transcriptResult, transcriptText } from "./transcript-text.ts";

const PAGE_SIZE = 60;

/** Raw canonical history, not model context: compaction never hides the agent's work. */
export function buildTranscript(
	record: AgentRecord, branch: readonly SessionEntry[], live: readonly TranscriptEntry[] = [], before?: string,
): TranscriptSnapshot {
	const path = record.descriptor.path;
	const boundary = branch.findIndex(entry => entry.type === "custom" && entry.customType === DESCRIPTOR_CUSTOM_TYPE &&
		(entry.data as { id?: unknown } | undefined)?.id === record.descriptor.id);
	if (boundary < 0) return { path, status: record.status, entries: [], inheritedCount: 0, error: "Agent descriptor boundary is missing." };
	const owned = branch.slice(boundary + 1);
	const cursorIndex = before === undefined ? owned.length : owned.findIndex(entry => {
		if (entry.id === before || `assistant:${entry.id}` === before) return true;
		if (!before.startsWith("tool:") || entry.type !== "message") return false;
		const callId = before.slice(5);
		return entry.message.role === "assistant" ?
			entry.message.content.some(block => block.type === "toolCall" && transcriptIdentifier(block.id) === callId) :
			entry.message.role === "toolResult" && (transcriptIdentifier(entry.message.toolCallId) === callId ||
				entry.message.nestedCalls?.calls.some(call => transcriptIdentifier(call.id) === callId));
	});
	const end = cursorIndex;
	if (end < 0) return { path, status: record.status, entries: [], inheritedCount: boundary, error: "History cursor is no longer on the canonical branch." };
	const start = Math.max(0, end - PAGE_SIZE);
	const calls = new Map<string, { name: string; arguments: unknown; timestamp: number }>();
	const results = new Map<string, Extract<SessionEntry, { type: "message" }>["message"]>();
	const finalTools = new Set<string>();
	const finalized = new Set<string>();
	for (const entry of owned) if (entry.type === "message") {
		const message = entry.message;
		if (message.role === "assistant") {
			finalized.add(`assistant:${entry.id}`);
			for (const block of message.content) if (block.type === "toolCall") calls.set(block.id, {
				name: block.name, arguments: block.arguments, timestamp: message.timestamp,
			});
		} else if (message.role === "toolResult") {
			results.set(message.toolCallId, message);
			finalTools.add(`tool:${transcriptIdentifier(message.toolCallId)}`);
		}
	}
	const entries = new Map<string, TranscriptEntry>();
	const putTool = (toolCallId: string, fallback: string, timestamp: number): void => {
		const id = `tool:${transcriptIdentifier(toolCallId)}`;
		const call = calls.get(toolCallId);
		const result = results.get(toolCallId);
		entries.set(id, {
			id, kind: "tool", timestamp: call?.timestamp ?? timestamp, toolName: transcriptText(call?.name ?? fallback, 80),
			toolCallId: transcriptIdentifier(toolCallId),
			args: transcriptArgs(call?.arguments),
			status: result?.role === "toolResult" ? result.isError ? "error" : "success" :
				record.status === "running" ? "running" : "interrupted",
			...(result?.role === "toolResult" ? { result: transcriptResult(result, result.isError) } : {}),
		});
	};
	for (const entry of owned.slice(start, end)) {
		const timestamp = Date.parse(entry.timestamp);
		if (entry.type === "message") {
			const message = entry.message;
			if (message.role === "assistant") {
				const tools = message.content.filter(block => block.type === "toolCall");
				const text = transcriptContent(message.content.filter(block => block.type === "text"));
				const error = message.errorMessage ? transcriptText(message.errorMessage) : "";
				entries.set(`assistant:${entry.id}`, {
					id: `assistant:${entry.id}`, kind: "assistant", timestamp: message.timestamp,
					message: transcriptMessage(message),
					status: message.stopReason === "error" ? "error" : message.stopReason === "aborted" ? "interrupted" : "success",
					text: [text, error].filter(Boolean).join("\n"),
				});
				for (const tool of tools) putTool(tool.id, tool.name, message.timestamp);
			} else if (message.role === "toolResult") {
				putTool(message.toolCallId, message.toolName, message.timestamp);
				for (const call of message.nestedCalls?.calls ?? []) entries.set(`tool:${transcriptIdentifier(call.id)}`, {
					id: `tool:${transcriptIdentifier(call.id)}`, kind: "tool", timestamp: message.timestamp,
					toolCallId: transcriptIdentifier(call.id),
					toolName: transcriptText(call.name, 80), args: transcriptArgs(call.arguments),
					status: call.status === "ok" ? "success" : call.status === "error" ? "error" : "interrupted",
					parentToolCallId: transcriptIdentifier(message.toolCallId),
					text: call.error ? transcriptText(call.error) : "Nested output was not saved by Pi.",
					...(call.durationMs !== undefined ? { result: transcriptResult({
						content: "",
					}, call.status === "error", call.durationMs) } : {}),
				});
			} else if (message.role === "user" || (message.role === "custom" && message.display)) {
				entries.set(entry.id, { id: entry.id, kind: "user", status: "info", timestamp,
					text: transcriptContent(message.content), message: transcriptMessage(message) });
			} else if (message.role === "bashExecution") {
				entries.set(entry.id, {
					id: entry.id, kind: "tool", timestamp, toolName: "bash",
					message: transcriptMessage(message),
					args: { command: transcriptText(message.command) },
					status: message.cancelled ? "interrupted" : message.exitCode === 0 ? "success" : "error",
					result: transcriptResult({ content: message.output }, message.exitCode !== 0),
				});
			} else if (message.role === "compactionSummary" || message.role === "branchSummary") {
				entries.set(entry.id, { id: entry.id, kind: "notice", status: "info", timestamp,
					text: transcriptText(message.summary), message: transcriptMessage(message) });
			}
		} else if (entry.type === "custom_message" && entry.display) {
			entries.set(entry.id, { id: entry.id, kind: "user", status: "info", timestamp, text: transcriptContent(entry.content),
				message: transcriptMessage({ role: "custom", customType: entry.customType, content: entry.content,
					display: entry.display, details: entry.details, timestamp }) });
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			entries.set(entry.id, { id: entry.id, kind: "notice", status: "info", timestamp,
				message: transcriptMessage(entry.type === "compaction" ?
					{ role: "compactionSummary", summary: entry.summary, tokensBefore: entry.tokensBefore, timestamp } :
					{ role: "branchSummary", summary: entry.summary, fromId: entry.fromId, timestamp }),
				text: `${entry.type === "compaction" ? "Compaction" : "Branch summary"}\n${transcriptText(entry.summary)}` });
		}
	}
	for (const item of live) {
		if (item.kind === "assistant" && finalized.has(item.id)) continue;
		// Persisted top-level tool results are authoritative (including hook redactions).
		if (item.kind === "tool" && !item.parentToolCallId && finalTools.has(item.id)) continue;
		if (before !== undefined && !entries.has(item.id)) continue;
		if (start > 0 && !entries.has(item.id) && item.status !== "running" && item.timestamp < Date.parse(owned[start]!.timestamp)) continue;
		entries.set(item.id, structuredClone(item));
	}
	return {
		path, status: record.status, entries: boundTranscript([...entries.values()].sort((a, b) => a.timestamp - b.timestamp)),
		inheritedCount: branch.slice(0, boundary).filter(entry => entry.type === "message" || entry.type === "custom_message").length,
		...(start > 0 ? { before: owned[start]!.id } : {}),
	};
}
