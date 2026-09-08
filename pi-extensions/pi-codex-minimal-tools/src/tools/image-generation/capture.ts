import type { ProviderEventContext } from "../../providers/openai-codex/stream-effects.js";
import type { StreamEventShape } from "../../providers/openai-codex/types.js";
import { loadSettings } from "../../settings.js";
import { normalizeImageOutputFormat, saveOpenAICodexGeneratedImage } from "./storage.js";
import type { SavedGeneratedImage } from "./types.js";

export function createImageCapture(
	context: ProviderEventContext,
	onImageSaved: (image: SavedGeneratedImage, data: { data: string; mimeType: string }) => void,
	saveImage = saveOpenAICodexGeneratedImage,
) {
	let responseId: string | undefined;
	return async (event: StreamEventShape): Promise<void> => {
		if (event.type === "response.created" && event.response?.id) responseId = event.response.id;
		if (context.signal?.aborted) return;
		if (event.type !== "response.output_item.done" || event.item?.type !== "image_generation_call") return;
		const callId = typeof event.item.id === "string" ? event.item.id : undefined;
		const result = typeof event.item.result === "string" ? event.item.result : undefined;
		if (!callId || !result) return;
		try {
			const outputFormat = typeof event.item.output_format === "string" ? event.item.output_format : undefined;
			const normalizedOutputFormat = normalizeImageOutputFormat(outputFormat);
			const settings = loadSettings(context.cwd);
			const imageModel = typeof event.item.model === "string" ? event.item.model : settings.imageModel;
			const saved = await saveImage(context.cwd, {
				responseId,
				callId,
				result,
				outputFormat: normalizedOutputFormat,
				imageModel,
				revisedPrompt:
					typeof event.item.revised_prompt === "string" ? event.item.revised_prompt : context.requestPrompt,
			});
			if (!context.signal?.aborted) {
				onImageSaved(saved, { data: result, mimeType: `image/${normalizedOutputFormat}` });
			}
		} catch {
			// Persistence is best-effort. Raw diagnostics here would corrupt the
			// active TUI; failures must not discard the provider response/replay.
		}
	};
}
