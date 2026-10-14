import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
import type { TranscriptEntry } from "./dashboard-types.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent, ToolCall, Usage } from "@earendil-works/pi-ai";

export const TRANSCRIPT_TEXT_LIMIT = 16_384;
export const TRANSCRIPT_BYTE_LIMIT = 1_048_576;

/** Oversized provider identifiers must not bypass content/cache limits. */
export function transcriptIdentifier(value: string): string {
	return value.length <= 256 ? value : `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

/** Display copies only: never mutate transcript values or replay signatures. */
export function transcriptText(value: string, limit = TRANSCRIPT_TEXT_LIMIT): string {
	const input = value.slice(0, limit * 2);
	const plain = stripTerminalSequences(input.replace(/\r\n?/g, "\n"))
		.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
	const characters = Array.from(plain);
	return characters.slice(0, limit).join("") +
		(value.length > input.length || characters.length > limit ? "\n… [content truncated]" : "");
}

function structuredCopy(value: unknown, initialBudget: number): unknown {
	let budget = initialBudget;
	const important = ["exitCode", "cancelled", "truncated", "fullOutputPath", "firstChangedLine", "truncation", "diff", "patch", "files", "summary"];
	const copy = (input: unknown, depth: number): unknown => {
		if (budget <= 0) return "…";
		budget -= 4; // Charge even omitted depth-limit placeholders and empty containers.
		if (depth > 6) return "…";
		if (typeof input === "string") {
			const text = transcriptText(input, Math.max(0, Math.min(budget, 4096)));
			budget -= text.length;
			return text;
		}
		if (input === null || typeof input === "boolean") { budget -= 5; return input; }
		if (typeof input === "number") { budget -= 24; return Number.isFinite(input) ? input : null; }
		if (Array.isArray(input)) {
			const result: unknown[] = [];
			for (const item of input.slice(0, 32)) {
				if (budget <= 0) break;
				result.push(copy(item, depth + 1));
			}
			if (result.length < input.length) result.push("… [items omitted]");
			return result;
		}
		if (!input || typeof input !== "object") return undefined;
		const result: Record<string, unknown> = Object.create(null);
		let count = 0;
		const source = input as Record<string, unknown>;
		if (source.type === "image" || source.type === "thinking" ||
			(typeof source.data === "string" && typeof source.mimeType === "string")) return undefined;
		const keys = [...important.filter(key => Object.hasOwn(source, key)), ...Object.keys(source).filter(key => !important.includes(key))];
		for (const key of keys) {
			// Opaque replay payloads and binary content have no place in a viewer.
			if (/signature|thinking|base64/i.test(key)) continue;
			if (++count > 32 || budget <= 0) { result["…"] = "[fields omitted]"; break; }
			const label = transcriptText(key, 80);
			budget -= label.length;
			const field = source[key];
			if (typeof field === "string" && (key === "diff" || key === "patch") && initialBudget > 8192) {
				result[label] = transcriptText(field, Math.max(0, Math.min(budget, TRANSCRIPT_TEXT_LIMIT)));
				budget -= (result[label] as string).length;
			} else result[label] = copy(field, depth + 1);
		}
		return result;
	};
	return copy(value, 0);
}

function recordCopy(value: unknown, budget: number): Record<string, unknown> {
	const result = structuredCopy(value, budget);
	return result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : {};
}

export function transcriptArgs(value: unknown): Record<string, unknown> { return recordCopy(value, 8192); }
export function transcriptDetails(value: unknown): Record<string, unknown> { return recordCopy(value, 32_768); }

function messageBlocks(value: unknown, includeTools: boolean): (TextContent | ToolCall)[] {
	if (!Array.isArray(value)) return [];
	const blocks: (TextContent | ToolCall)[] = [];
	let remaining = TRANSCRIPT_TEXT_LIMIT;
	for (const block of value.slice(0, 256)) {
		if (block?.type === "text" && typeof block.text === "string") {
			if (remaining <= 0) continue;
			const text = transcriptText(block.text, remaining);
			remaining -= text.length;
			blocks.push({ type: "text", text });
		} else if (includeTools && block?.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") {
			blocks.push({
				type: "toolCall", id: transcriptIdentifier(block.id),
				name: transcriptText(block.name, 80), arguments: {},
				...(typeof block.namespace === "string" ? { namespace: transcriptText(block.namespace, 80) } : {}),
			});
		}
	}
	if (value.length > 256) blocks.push({ type: "text", text: "… [content blocks omitted]" });
	return blocks;
}

function messageUsage(usage: Usage): Usage {
	const number = (value: number) => Number.isFinite(value) ? value : 0;
	return {
		input: number(usage.input), output: number(usage.output), cacheRead: number(usage.cacheRead),
		cacheWrite: number(usage.cacheWrite), totalTokens: number(usage.totalTokens),
		...(usage.reasoning !== undefined ? { reasoning: number(usage.reasoning) } : {}),
		...(usage.cacheWrite1h !== undefined ? { cacheWrite1h: number(usage.cacheWrite1h) } : {}),
		cost: { input: number(usage.cost.input), output: number(usage.cost.output), cacheRead: number(usage.cost.cacheRead),
			cacheWrite: number(usage.cost.cacheWrite), total: number(usage.cost.total) },
	};
}

/** Native renderers receive real roles/content, never synthetic response messages. */
export function transcriptMessage(message: AgentMessage): AgentMessage | undefined {
	switch (message.role) {
		case "assistant": return {
			role: "assistant", content: messageBlocks(message.content, true), timestamp: message.timestamp,
			api: transcriptText(message.api, 80), provider: transcriptText(message.provider, 80), model: transcriptText(message.model, 256),
			usage: messageUsage(message.usage), stopReason: message.stopReason,
			...(message.errorMessage !== undefined ? { errorMessage: transcriptText(message.errorMessage) } : {}),
			...(message.responseModel !== undefined ? { responseModel: transcriptText(message.responseModel, 256) } : {}),
			...(message.responseId !== undefined ? { responseId: transcriptIdentifier(message.responseId) } : {}),
			...(message.providerThinkingLevel !== undefined ? { providerThinkingLevel: transcriptText(message.providerThinkingLevel, 80) } : {}),
			...(message.thinkingLevel !== undefined ? { thinkingLevel: message.thinkingLevel } : {}),
			...(message.rawStopReason !== undefined ? { rawStopReason: transcriptText(message.rawStopReason, 80) } : {}),
			...(message.durationMs !== undefined && Number.isFinite(message.durationMs) ? { durationMs: message.durationMs } : {}),
			...(message.endTurn !== undefined ? { endTurn: message.endTurn } : {}),
		};
		case "user": return {
			role: "user", timestamp: message.timestamp,
			content: typeof message.content === "string" ? transcriptText(message.content) : messageBlocks(message.content, false) as TextContent[],
		};
		case "custom": return {
			role: "custom", timestamp: message.timestamp, display: message.display,
			customType: transcriptText(message.customType, 256),
			content: typeof message.content === "string" ? transcriptText(message.content) : messageBlocks(message.content, false) as TextContent[],
			...(message.details !== undefined ? { details: structuredCopy(message.details, 32_768) } : {}),
		};
		case "bashExecution": return {
			role: "bashExecution", timestamp: message.timestamp, command: transcriptText(message.command),
			output: transcriptText(message.output), exitCode: message.exitCode,
			cancelled: message.cancelled, truncated: message.truncated,
			...(message.fullOutputPath !== undefined ? { fullOutputPath: transcriptText(message.fullOutputPath, 4096) } : {}),
			...(message.excludeFromContext !== undefined ? { excludeFromContext: message.excludeFromContext } : {}),
		};
		case "compactionSummary": return {
			role: "compactionSummary", timestamp: message.timestamp, tokensBefore: message.tokensBefore, summary: transcriptText(message.summary),
		};
		case "branchSummary": return {
			role: "branchSummary", timestamp: message.timestamp, fromId: message.fromId === null ? null : transcriptIdentifier(message.fromId),
			summary: transcriptText(message.summary),
		};
		default: return undefined;
	}
}

export function transcriptContent(value: unknown): string {
	if (typeof value === "string") return transcriptText(value);
	if (!Array.isArray(value)) return "";
	let text = "";
	for (const block of value.slice(0, 256)) {
		const remaining = TRANSCRIPT_TEXT_LIMIT - text.length;
		if (remaining <= 0) { text += "\n… [content truncated]"; break; }
		if (block?.type === "text" && typeof block.text === "string") {
			text += (text ? "\n" : "") + transcriptText(block.text, remaining);
		} else if (block?.type === "image") text += transcriptText("\n[image omitted]", remaining);
	}
	if (value.length > 256) text += "\n… [content blocks omitted]";
	return text;
}

export function transcriptResult(value: unknown, isError: boolean, durationMs?: number): NonNullable<TranscriptEntry["result"]> {
	const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
	const text = transcriptContent(input.content ?? (typeof value === "string" ? value : ""));
	const duration = durationMs ?? input.durationMs;
	return {
		content: [{ type: "text", text }],
		isError,
		...(input.details && typeof input.details === "object" && !Array.isArray(input.details) ? { details: transcriptDetails(input.details) } : {}),
		...(typeof duration === "number" && Number.isFinite(duration) && duration >= 0 ? { durationMs: duration } : {}),
	};
}

/** Bound a page/active trace in bytes as well as in records. */
export function boundTranscript(entries: TranscriptEntry[]): TranscriptEntry[] {
	if (entries.length > 400) entries = [{
		id: "notice:display-limit", kind: "notice", status: "info", timestamp: entries[0]!.timestamp,
		text: `${entries.length - 399} earlier display records omitted from this page.`, truncated: true,
	}, ...entries.slice(-399)];
	let remaining = TRANSCRIPT_BYTE_LIMIT;
	return entries.map((entry, index) => {
		const size = Buffer.byteLength(JSON.stringify(entry));
		const allowance = Math.max(512, Math.floor(remaining / (entries.length - index)));
		if (size <= allowance) { remaining -= size; return entry; }
		let compact: TranscriptEntry = {
			...entry, truncated: true,
			// Structured messages must not bypass the byte budget via the spread.
			message: undefined,
			text: entry.text ? transcriptText(entry.text, 160) : undefined,
			args: entry.args ? { preview: transcriptText(JSON.stringify(entry.args), 240) } : undefined,
			result: entry.result ? {
				content: [{ type: "text", text: transcriptText(entry.result.content.map(block => block.text).join("\n"), 240) }],
				isError: entry.result.isError,
				...(entry.result.durationMs !== undefined ? { durationMs: entry.result.durationMs } : {}),
			} : undefined,
		};
		if (Buffer.byteLength(JSON.stringify(compact)) > allowance) compact = {
			id: `notice:oversized:${index}`, kind: "notice", status: "info", timestamp: entry.timestamp,
			text: "Display record omitted because its metadata exceeds the page bound.", truncated: true,
		};
		remaining -= Buffer.byteLength(JSON.stringify(compact));
		return compact;
	});
}
