import { APPROX_BYTES_PER_TOKEN, CODEX_MAX_RETAINED_AGENT_MESSAGE_TOKENS, CODEX_RETAINED_MESSAGE_TOKEN_BUDGET } from "../../providers/openai-codex/constants.js";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";

export function syntheticNativeAssistant(
	output: readonly unknown[],
	model: Model<Api>,
	timestamp: number,
): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: output.map((item) => ({
			type: "thinking",
			thinking: "",
			thinkingSignature: JSON.stringify(item),
			redacted: true,
		})) as AssistantMessage["content"],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

export function compactionItems(output: unknown): unknown[] {
	if (!Array.isArray(output)) throw new Error("OpenAI native compaction response omitted output");
	return output.filter(isNativeCompactionItem);
}

export function isNativeCompactionItem(item: unknown): item is Record<string, unknown> {
	const type = item && typeof item === "object" ? (item as { type?: unknown }).type : undefined;
	return type === "compaction" || type === "context_compaction";
}

function approxTokenCount(text: string): number {
	return Math.ceil(Buffer.byteLength(text) / APPROX_BYTES_PER_TOKEN);
}

function serializedTokenCount(item: Record<string, unknown>): number {
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

function retainResponseMessage(
	item: Record<string, unknown>,
	parts: unknown[],
	maxTokens: number,
): { item: Record<string, unknown>; tokens: number } | undefined {
	let remaining = maxTokens;
	const content: unknown[] = [];
	for (const part of parts) {
		if (remaining <= 0) break;
		if (!part || typeof part !== "object" || Array.isArray(part)) continue;
		const record = part as Record<string, unknown>;
		const text = (record.type === "input_text" || record.type === "output_text") && typeof record.text === "string"
			? record.text : undefined;
		// Charge the full wire payload for atomic parts, not an estimate of model billing.
		const tokenCount = text === undefined ? serializedTokenCount(record) : Math.max(1, approxTokenCount(text));
		if (tokenCount <= remaining) {
			content.push(part);
			remaining -= tokenCount;
		} else if (text !== undefined) {
			content.push({ ...record, text: truncateUtf8Prefix(text, remaining * APPROX_BYTES_PER_TOKEN) });
			remaining = 0;
		}
	}
	return content.length > 0 ? { item: { ...item, type: "message", content }, tokens: maxTokens - remaining } : undefined;
}

function retainCompactionItem(
	item: unknown,
	remaining: number,
): { item: Record<string, unknown>; tokens: number } | undefined {
	if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
	const record = item as Record<string, unknown>;
	if (
		(record.type === undefined || record.type === "message")
		&& record.role === "user"
		&& Array.isArray(record.content)
	) {
		return retainResponseMessage(record, record.content, remaining);
	}
	if (record.type !== "agent_message" || !Array.isArray(record.content)) return undefined;
	const first = record.content[0];
	const firstText = first && typeof first === "object" ? (first as { text?: unknown }).text : undefined;
	if (typeof firstText === "string" && firstText.startsWith("Message Type: FINAL_ANSWER\n")) {
		return undefined;
	}
	const tokens = serializedTokenCount(record);
	return tokens <= Math.min(remaining, CODEX_MAX_RETAINED_AGENT_MESSAGE_TOKENS)
		? { item: record, tokens } : undefined;
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
	let remaining = CODEX_RETAINED_MESSAGE_TOKEN_BUDGET;
	const retainedReversed: Record<string, unknown>[] = [];
	for (let index = input.length - 1; index >= 0 && remaining > 0; index--) {
		const retained = retainCompactionItem(input[index], remaining);
		if (!retained) continue;
		retainedReversed.push(retained.item);
		remaining -= retained.tokens;
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
