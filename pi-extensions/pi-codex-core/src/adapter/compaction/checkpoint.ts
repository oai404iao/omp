import { APPROX_BYTES_PER_TOKEN, CODEX_MAX_RETAINED_AGENT_MESSAGE_TOKENS, CODEX_RETAINED_MESSAGE_TOKEN_BUDGET } from "../../providers/openai-codex/constants.js";

export function compactionItems(output: unknown): unknown[] {
	if (!Array.isArray(output)) throw new Error("OpenAI native compaction response omitted output");
	return output.filter(isNativeCompactionItem);
}

export function isNativeCompactionItem(item: unknown): item is Record<string, unknown> {
	const type = item && typeof item === "object" ? (item as { type?: unknown }).type : undefined;
	return type === "compaction" || type === "context_compaction";
}

function approxTokenCount(text: string): number {
	const bytes = new TextEncoder().encode(text).byteLength;
	return Math.ceil(bytes / APPROX_BYTES_PER_TOKEN);
}

function responseItemTokenCount(item: Record<string, unknown>): number {
	if (item.type === "message" && Array.isArray(item.content)) {
		const tokens = item.content.reduce((total, part) => {
			if (!part || typeof part !== "object") return total;
			const text = (part as { text?: unknown }).text;
			return typeof text === "string" ? total + approxTokenCount(text) : total;
		}, 0);
		return Math.max(1, tokens);
	}
	try {
		return Math.max(1, approxTokenCount(JSON.stringify(item)));
	} catch {
		return Number.MAX_SAFE_INTEGER;
	}
}

function truncateUtf8Prefix(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const encoder = new TextEncoder();
	if (encoder.encode(text).byteLength <= maxBytes) return text;
	let result = "";
	let bytes = 0;
	for (const character of text) {
		const characterBytes = encoder.encode(character).byteLength;
		if (bytes + characterBytes > maxBytes) break;
		result += character;
		bytes += characterBytes;
	}
	return result;
}

function truncateResponseMessage(
	item: Record<string, unknown>,
	maxTokens: number,
): Record<string, unknown> | undefined {
	if (item.type !== "message" || !Array.isArray(item.content) || maxTokens <= 0) return undefined;
	let remaining = maxTokens;
	const content: unknown[] = [];
	for (const part of item.content) {
		if (!part || typeof part !== "object" || Array.isArray(part)) continue;
		const record = part as Record<string, unknown>;
		if (typeof record.text !== "string") {
			content.push(part);
			continue;
		}
		if (remaining <= 0) continue;
		const tokenCount = approxTokenCount(record.text);
		if (tokenCount <= remaining) {
			content.push(part);
			remaining -= tokenCount;
			continue;
		}
		const text = truncateUtf8Prefix(record.text, remaining * APPROX_BYTES_PER_TOKEN);
		if (text) content.push({ ...record, text });
		remaining = 0;
	}
	return content.length > 0 ? { ...item, content } : undefined;
}

function retainedResponsesCompactionItem(item: unknown): Record<string, unknown> | undefined {
	if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
	const record = item as Record<string, unknown>;
	if (
		(record.type === undefined || record.type === "message")
		&& record.role === "user"
		&& Array.isArray(record.content)
	) {
		return { ...record, type: "message" };
	}
	if (record.type !== "agent_message" || !Array.isArray(record.content)) return undefined;
	const first = record.content[0];
	const firstText = first && typeof first === "object" ? (first as { text?: unknown }).text : undefined;
	if (typeof firstText === "string" && firstText.startsWith("Message Type: FINAL_ANSWER\n")) {
		return undefined;
	}
	return responseItemTokenCount(record) <= CODEX_MAX_RETAINED_AGENT_MESSAGE_TOKENS
		? record
		: undefined;
}

/**
 * Match Codex remote compaction v2's installed checkpoint shape: retain the
 * newest real user messages plus bounded delegated-agent state, drop stale
 * developer/system/assistant/tool state, then append the opaque compaction
 * item returned by Responses.
 */
export function buildCodexCompactionCheckpoint(
	input: unknown[],
	compactionItem: unknown,
): unknown[] {
	const candidates = input
		.map(retainedResponsesCompactionItem)
		.filter((item): item is Record<string, unknown> => !!item);
	let remaining = CODEX_RETAINED_MESSAGE_TOKEN_BUDGET;
	const retainedReversed: Record<string, unknown>[] = [];
	for (let index = candidates.length - 1; index >= 0 && remaining > 0; index--) {
		const item = candidates[index]!;
		const tokenCount = responseItemTokenCount(item);
		if (tokenCount <= remaining) {
			retainedReversed.push(item);
			remaining -= tokenCount;
			continue;
		}
		const truncated = truncateResponseMessage(item, remaining);
		if (truncated) {
			retainedReversed.push(truncated);
			remaining = 0;
		}
	}
	retainedReversed.reverse();
	return [...retainedReversed, compactionItem];
}

function hasNonEmptyResponseMessageContent(item: Record<string, unknown>): boolean {
	if (item.type !== "message") return false;
	if (item.role !== "user" && item.role !== "assistant") return false;
	if (!Array.isArray(item.content)) return false;
	return item.content.some((part) => {
		if (!part || typeof part !== "object") return false;
		const content = part as Record<string, unknown>;
		return (
			(typeof content.text === "string" && content.text.trim().length > 0)
			|| (typeof content.refusal === "string" && content.refusal.trim().length > 0)
			|| typeof content.image_url === "string"
		);
	});
}

/**
 * Install remote compaction as a fresh history checkpoint, following Codex's
 * compaction reducer: preserve only safe message/checkpoint items and discard
 * reasoning, tool calls, and tool outputs. Replaying a partial call pair is
 * invalid Responses input and can detach tool arguments from their result.
 */
export function sanitizeNativeCompactionOutput(output: unknown[]): unknown[] {
	return output.filter((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return false;
		const record = item as Record<string, unknown>;
		if (record.type === "compaction" || record.type === "context_compaction") return true;
		return hasNonEmptyResponseMessageContent(record);
	});
}
