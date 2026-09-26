import type { AssistantMessage } from "@earendil-works/pi-ai";
import { sanitizeResponseMessageItem, sanitizeWebSearchCallItem } from "./items.js";
import { type ReplayableResponseMessageItem, type ReplayableWebSearchCallItem, type TextSignaturePhase } from "./types.js";

export const WEB_SEARCH_ACTIVITY_TEXT_SIGNATURE_PREFIX = "pi:web-search-activity:";

const LEAKED_CITATION_PROTOCOL = /cite[^]+|【\d+†source】/i;

function encodeTextSignatureV1(id: string, phase?: string): string {
	const payload: { v: 1; id: string; phase?: string } = { v: 1, id };
	if (phase) payload.phase = phase;
	return JSON.stringify(payload);
}

export function encodeTextSignature(item: unknown, renderedText?: string): string {
	let replayItem = sanitizeResponseMessageItem(item);
	if (!replayItem) {
		const candidate = item && typeof item === "object" ? item as Record<string, unknown> : undefined;
		return encodeTextSignatureV1(
			typeof candidate?.id === "string" ? candidate.id : "msg_unknown",
			typeof candidate?.phase === "string" ? candidate.phase : undefined,
		);
	}
	const rawText = replayItem.content
		.map((part) => part.type === "output_text" ? part.text : part.refusal)
		.join("");
	if (
		renderedText !== undefined
		&& renderedText !== rawText
		&& replayItem.content.every((part) => part.type === "output_text")
		&& LEAKED_CITATION_PROTOCOL.test(rawText)
	) {
		replayItem = {
			...replayItem,
			content: [{ type: "output_text", text: renderedText, annotations: [] }],
		};
	}
	return JSON.stringify({ v: 2, item: replayItem });
}

export function parseTextSignature(signature: string | undefined): {
	id: string;
	phase?: TextSignaturePhase;
	item?: ReplayableResponseMessageItem;
} | undefined {
	if (!signature) return undefined;
	if (signature.startsWith("{")) {
		try {
			const parsed = JSON.parse(signature) as {
				v?: number;
				id?: string;
				phase?: TextSignaturePhase | string;
				item?: unknown;
			};
			if (parsed.v === 2) {
				const item = sanitizeResponseMessageItem(parsed.item);
				if (item) {
					return {
						id: item.id,
						...(item.phase ? { phase: item.phase } : {}),
						item,
					};
				}
			}
			if (parsed.v === 1 && typeof parsed.id === "string") {
				return parsed.phase === "commentary" || parsed.phase === "final_answer"
					? { id: parsed.id, phase: parsed.phase }
					: { id: parsed.id };
			}
		} catch {
			// Fall through to legacy plain-string handling.
		}
	}
	return { id: signature };
}

export function isWebSearchActivityTextSignature(signature: string | undefined): boolean {
	return signature?.startsWith(WEB_SEARCH_ACTIVITY_TEXT_SIGNATURE_PREFIX) === true;
}

export function encodeWebSearchActivityTextSignature(callId: string, item?: unknown): string {
	const replayItem = sanitizeWebSearchCallItem(item);
	if (!replayItem || replayItem.id !== callId) {
		return `${WEB_SEARCH_ACTIVITY_TEXT_SIGNATURE_PREFIX}${callId}`;
	}
	return `${WEB_SEARCH_ACTIVITY_TEXT_SIGNATURE_PREFIX}${callId}:${JSON.stringify({ v: 2, item: replayItem })}`;
}

export function decodeWebSearchActivityTextSignature(signature: string | undefined): ReplayableWebSearchCallItem | undefined {
	if (!isWebSearchActivityTextSignature(signature)) return undefined;
	const payload = signature!.slice(WEB_SEARCH_ACTIVITY_TEXT_SIGNATURE_PREFIX.length);
	const separator = payload.indexOf(":");
	if (separator < 1) return undefined;
	const callId = payload.slice(0, separator);
	try {
		const parsed = JSON.parse(payload.slice(separator + 1)) as { v?: number; item?: unknown };
		if (parsed.v !== 2) return undefined;
		const item = sanitizeWebSearchCallItem(parsed.item);
		return item?.id === callId ? item : undefined;
	} catch {
		return undefined;
	}
}
export function backfillReasoningSignatures(output: AssistantMessage, items: unknown[]): void {
	const encryptedById = new Map<string, string>();
	for (const value of items) {
		const item = value as { type?: unknown; id?: unknown; encrypted_content?: unknown } | null;
		if (item?.type === "reasoning" && typeof item.id === "string" && typeof item.encrypted_content === "string" && item.encrypted_content) {
			encryptedById.set(item.id, item.encrypted_content);
		}
	}
	if (encryptedById.size === 0) return;
	for (const block of output.content) {
		if (block.type !== "thinking" || !block.thinkingSignature) continue;
		const item = JSON.parse(block.thinkingSignature);
		const encrypted = encryptedById.get(item.id);
		if (item.type === "reasoning" && encrypted && !item.encrypted_content) {
			block.thinkingSignature = JSON.stringify({ ...item, encrypted_content: encrypted });
		}
	}
}
