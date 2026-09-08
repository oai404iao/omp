import { type ImageGenerationCallBlock, type ImageGenerationCallItem, type InternalAssistantContent, type ReplayableResponseMessageContent, type ReplayableResponseMessageItem, type ReplayableWebSearchCallItem } from "./types.js";

export function cloneJsonRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	try {
		const cloned = JSON.parse(JSON.stringify(value)) as unknown;
		return cloned && typeof cloned === "object" && !Array.isArray(cloned)
			? cloned as Record<string, unknown>
			: undefined;
	} catch {
		return undefined;
	}
}

export function sanitizeWebSearchCallItem(item: unknown): ReplayableWebSearchCallItem | undefined {
	if (!item || typeof item !== "object") return undefined;
	const candidate = item as Record<string, unknown>;
	if (candidate.type !== "web_search_call") return undefined;
	if (typeof candidate.id !== "string" || candidate.id === "") return undefined;
	if (candidate.status !== "completed") return undefined;
	const action = cloneJsonRecord(candidate.action);
	if (!action) return undefined;
	const results = Array.isArray(candidate.results)
		? candidate.results.map(cloneJsonRecord).filter((result): result is Record<string, unknown> => !!result)
		: undefined;

	return {
		type: "web_search_call",
		id: candidate.id,
		status: "completed",
		action,
		...(results ? { results } : {}),
	};
}

export function sanitizeResponseMessageItem(item: unknown): ReplayableResponseMessageItem | undefined {
	if (!item || typeof item !== "object") return undefined;
	const candidate = item as Record<string, unknown>;
	if (candidate.type !== "message") return undefined;
	if (typeof candidate.id !== "string" || candidate.id === "") return undefined;
	const rawContent = Array.isArray(candidate.content) ? candidate.content : [];
	const content: ReplayableResponseMessageContent[] = [];
	for (const rawPart of rawContent) {
		if (!rawPart || typeof rawPart !== "object") continue;
		const part = rawPart as Record<string, unknown>;
		if (part.type === "output_text" && typeof part.text === "string") {
			const annotations = Array.isArray(part.annotations)
				? part.annotations.map(cloneJsonRecord).filter((annotation): annotation is Record<string, unknown> => !!annotation)
				: [];
			content.push({ type: "output_text", text: part.text, annotations });
		} else if (part.type === "refusal" && typeof part.refusal === "string") {
			content.push({ type: "refusal", refusal: part.refusal });
		}
	}
	const phase = candidate.phase === "commentary" || candidate.phase === "final_answer"
		? candidate.phase
		: undefined;
	return {
		type: "message",
		id: candidate.id,
		role: "assistant",
		status: "completed",
		content,
		...(phase ? { phase } : {}),
	};
}

export function isImageGenerationCallBlock(block: InternalAssistantContent): block is ImageGenerationCallBlock {
	return block.type === "image_generation_call" && block.item?.type === "image_generation_call";
}

export function sanitizeImageGenerationCallItem(item: unknown): ImageGenerationCallItem | undefined {
	if (!item || typeof item !== "object") return undefined;
	const candidate = item as Record<string, unknown>;
	if (candidate.type !== "image_generation_call") return undefined;
	if (typeof candidate.id !== "string" || candidate.id === "") return undefined;
	if (typeof candidate.status !== "string" || candidate.status === "") return undefined;
	if (!(typeof candidate.result === "string" || candidate.result === null)) return undefined;

	return {
		type: "image_generation_call",
		id: candidate.id,
		status: candidate.status,
		result: candidate.result,
		...(typeof candidate.revised_prompt === "string" ? { revised_prompt: candidate.revised_prompt } : {}),
	};
}
