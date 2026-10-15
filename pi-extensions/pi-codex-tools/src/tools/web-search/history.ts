/*
 * SPDX-FileCopyrightText: 2026 OpenAI
 * SPDX-FileCopyrightText: 2026 oai404iao
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified TypeScript adaptation of Codex response_history.rs and
 * utils/string/src/truncate.rs at 5a3140176e668a2f72f3c098490eb7f7052d9d85.
 */
import { buildSessionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { cloneJsonRecord } from "@oai404iao/pi-codex-runtime/internal/providers/responses/items";
import { isWebSearchActivityTextSignature, parseTextSignature } from "@oai404iao/pi-codex-runtime/internal/providers/responses/signatures";

interface SearchMessage {
	type: "message";
	role: "user" | "assistant";
	content: Array<Record<string, unknown>>;
	phase?: string;
	internal_chat_message_metadata_passthrough?: Record<string, unknown>;
}

function metadata(source: unknown): Record<string, unknown> | undefined {
	if (!source || typeof source !== "object") return undefined;
	return cloneJsonRecord((source as Record<string, unknown>).internal_chat_message_metadata_passthrough);
}

function signatureSource(signature: string | undefined): Record<string, unknown> | undefined {
	if (!signature?.startsWith("{")) return undefined;
	try {
		const value = JSON.parse(signature);
		return value?.v === 2 ? cloneJsonRecord(value.item) : undefined;
	} catch {
		return undefined;
	}
}

function truncateAssistantText(text: string, tokenBudget: number): string {
	const bytes = Buffer.from(text);
	const byteBudget = tokenBudget * 4;
	if (bytes.length <= byteBudget) return text;
	let prefixEnd = Math.floor(byteBudget / 2);
	let suffixStart = bytes.length - (byteBudget - prefixEnd);
	while (prefixEnd > 0 && (bytes[prefixEnd]! & 0xc0) === 0x80) prefixEnd--;
	while (suffixStart < bytes.length && (bytes[suffixStart]! & 0xc0) === 0x80) suffixStart++;
	const removedTokens = Math.ceil((bytes.length - byteBudget) / 4);
	return `${bytes.subarray(0, prefixEnd).toString()}…${removedTokens} tokens truncated…${bytes.subarray(suffixStart).toString()}`;
}

export function recentSearchInput(entries: SessionEntry[], turnId?: string): SearchMessage[] | undefined {
	const visible: SearchMessage[] = [];
	for (const message of buildSessionContext(entries).messages) {
		if (message.role !== "user" && message.role !== "assistant") continue;
		const sourceMetadata = metadata(message);
		if (message.role === "user") {
			const blocks = typeof message.content === "string"
				? [{ type: "text", text: message.content }]
				: message.content;
			const content = blocks.flatMap(part => part.type === "text" && part.text
				? [{ type: "input_text", text: part.text }] : []);
			if (!content.length || /^<environment_context>[\s\S]*<\/environment_context>$/i.test(content.map(part => part.text).join("\n").trim())) continue;
			visible.push({
				type: "message", role: "user", content,
				...(sourceMetadata ? { internal_chat_message_metadata_passthrough: sourceMetadata } : {}),
			});
			continue;
		}
		for (const part of message.content) {
			if (part.type !== "text" || isWebSearchActivityTextSignature(part.textSignature)) continue;
			const signature = parseTextSignature(part.textSignature);
			const original = signatureSource(part.textSignature);
			const itemMetadata = metadata(original) ?? sourceMetadata;
			const phase = original?.phase ?? signature?.phase;
			visible.push({
				type: "message", role: "assistant",
				content: signature?.item ? structuredClone(signature.item.content) : [{ type: "output_text", text: part.text }],
				...(["commentary", "partial_answer", "final_answer"].includes(String(phase)) ? { phase: String(phase) } : {}),
				...(itemMetadata ? { internal_chat_message_metadata_passthrough: structuredClone(itemMetadata) } : {}),
			});
		}
	}
	const users = visible.flatMap((message, index) => message.role === "user" ? [index] : []);
	const last = users.at(-1);
	if (last === undefined) return undefined;
	const tail = visible.slice(users.at(-2) ?? last, last + 1);
	const current = tail.at(-1)!;
	if (turnId && !current.internal_chat_message_metadata_passthrough?.turn_id) {
		current.internal_chat_message_metadata_passthrough = {
			...current.internal_chat_message_metadata_passthrough, turn_id: turnId,
		};
	}
	let budget = 1_000;
	for (const message of tail) {
		if (message.role !== "assistant") continue;
		message.content = message.content.flatMap(part => {
			if (part.type !== "output_text" || typeof part.text !== "string") return [part];
			if (!budget) return [];
			const tokens = Math.ceil(Buffer.byteLength(part.text) / 4);
			const text = tokens <= budget ? part.text : truncateAssistantText(part.text, budget);
			budget = Math.max(0, budget - tokens);
			return [{ ...part, text }];
		});
	}
	return tail.filter(message => message.content.length > 0);
}
