import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import type { ProviderEventContext } from "@oai404iao/pi-codex-runtime/internal/providers/openai-codex/stream-effects";
import type { StreamEventShape } from "@oai404iao/pi-codex-runtime/internal/providers/openai-codex/types";
import { encodeWebSearchActivityTextSignature } from "@oai404iao/pi-codex-runtime/internal/providers/responses/signatures";
import {
	buildWebSearchInlineText, extractWebSearch, extractWebSearchProgress,
	mergeWebSearchActivity, type SurfacedWebSearch,
} from "./activity.js";

export function createWebSearchCapture({ cwd, output, stream }: ProviderEventContext) {
	type TextBlock = Extract<AssistantMessage["content"][number], { type: "text" }>;
	const states = new Map<string, { search: SurfacedWebSearch; block: TextBlock; contentIndex: number }>();
	const updateActivity = (search: SurfacedWebSearch) => {
		const existing = states.get(search.callId);
		const merged = mergeWebSearchActivity(existing?.search, search);
		const text = buildWebSearchInlineText(merged, cwd);
		const textSignature = encodeWebSearchActivityTextSignature(merged.callId, merged.responseItem);
		if (existing) {
			existing.search = merged;
			existing.block.text = text;
			existing.block.textSignature = textSignature;
			stream.push({ type: "text_delta", contentIndex: existing.contentIndex, delta: "", partial: output });
			return;
		}
		const block: TextBlock = { type: "text", text: "", textSignature };
		output.content.push(block);
		const contentIndex = output.content.length - 1;
		states.set(search.callId, { search: merged, block, contentIndex });
		stream.push({ type: "text_start", contentIndex, partial: output });
		block.text = text;
		stream.push({ type: "text_delta", contentIndex, delta: text, partial: output });
	};
	return (event: StreamEventShape): void => {
		if (
			(event.type === "response.output_item.added" || event.type === "response.output_item.done")
			&& event.item?.type === "web_search_call"
		) {
			const search = extractWebSearch(event.item, { completed: event.type === "response.output_item.done" });
			if (search) updateActivity(search);
		}
		const progress = extractWebSearchProgress(event);
		if (progress) updateActivity(progress);
	};
}
