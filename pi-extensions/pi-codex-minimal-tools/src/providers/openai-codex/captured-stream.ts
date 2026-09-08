import { type Api, type AssistantMessage, type AssistantMessageEventStream, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { loadSettings } from "../../settings.js";
import { normalizeImageOutputFormat, saveOpenAICodexGeneratedImage } from "../../tools/image-generation/storage.js";
import { type SavedGeneratedImage } from "../../tools/image-generation/types.js";
import { buildWebSearchInlineText, extractWebSearch, extractWebSearchProgress, mergeWebSearchActivity, type SurfacedWebSearch } from "../../tools/web-search/activity.js";
import { encodeWebSearchActivityTextSignature } from "../responses/signatures.js";
import { processResponsesStream } from "../responses/stream.js";
import { type CitationSource, type WebSearchCitationSource } from "../responses/types.js";
import { mapCodexEvents } from "./events.js";
import { type ServiceTier, type StreamEventShape } from "./types.js";
import { applyServiceTierPricing, resolveCodexServiceTier } from "./usage.js";

async function* captureGeneratedImages(
	events: AsyncIterable<StreamEventShape>,
	options: {
		cwd: string;
		requestPrompt?: string;
		onImageSaved: (image: SavedGeneratedImage, imageData: { data: string; mimeType: string }) => void;
		onWebSearchCaptured?: (search: SurfacedWebSearch) => void;
	},
): AsyncIterable<StreamEventShape> {
	let responseId: string | undefined;

	for await (const event of events) {
		if (event.type === "response.created" && event.response?.id) {
			responseId = event.response.id;
		}

		if (event.type === "response.output_item.done" && event.item?.type === "image_generation_call") {
			const callId = typeof event.item.id === "string" ? event.item.id : undefined;
			const result = typeof event.item.result === "string" ? event.item.result : undefined;
			if (callId && result) {
				try {
					const outputFormat = typeof event.item.output_format === "string" ? event.item.output_format : undefined;
					const normalizedOutputFormat = normalizeImageOutputFormat(outputFormat);
					const settings = loadSettings(options.cwd);
					const imageModel = typeof event.item.model === "string" ? event.item.model : settings.imageModel;
					const saved = await saveOpenAICodexGeneratedImage(options.cwd, {
						responseId,
						callId,
						result,
						outputFormat: normalizedOutputFormat,
						imageModel,
						revisedPrompt:
							typeof event.item.revised_prompt === "string" ? event.item.revised_prompt : options.requestPrompt,
					});
					options.onImageSaved(saved, {
						data: result,
						mimeType: `image/${normalizedOutputFormat}`,
					});
				} catch {
					// Image persistence is best-effort. Do not write raw diagnostics to
					// stdout/stderr from inside the TUI; terminal output can corrupt active
					// widgets and boxes.
				}
			}
		}

		if (
			(event.type === "response.output_item.added" || event.type === "response.output_item.done")
			&& event.item?.type === "web_search_call"
		) {
			const search = extractWebSearch(event.item, { completed: event.type === "response.output_item.done" });
			if (search) {
				options.onWebSearchCaptured?.(search);
			}
		}

		const webSearchProgress = extractWebSearchProgress(event);
		if (webSearchProgress) {
			options.onWebSearchCaptured?.(webSearchProgress);
		}

		yield event;
	}
}

export async function processCapturedResponsesStream<TApi extends Api>(
	events: AsyncIterable<StreamEventShape>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<TApi>,
	options: SimpleStreamOptions | undefined,
	sessionKey: string | undefined,
	deps: {
		onImageSaved?: (savedImage: SavedGeneratedImage, imageData: { data: string; mimeType: string }) => void;
	},
	cwd: string,
	requestPrompt: string | undefined,
	webSearchCitationSources: ReadonlyArray<WebSearchCitationSource>,
	historicalCitationSources: ReadonlyArray<CitationSource>,
): Promise<{ responseId?: string; responseItems: unknown[] }> {
	type TextBlock = Extract<AssistantMessage["content"][number], { type: "text" }>;
	const responseItems: unknown[] = [];
	let responseId: string | undefined;
	const webSearchStates = new Map<string, { search: SurfacedWebSearch; block: TextBlock; contentIndex: number }>();
	const updateWebSearchActivity = (search: SurfacedWebSearch) => {
		const existing = webSearchStates.get(search.callId);
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

		const block: TextBlock = {
			type: "text",
			text: "",
			textSignature,
		};
		output.content.push(block);
		const contentIndex = output.content.length - 1;
		webSearchStates.set(search.callId, { search: merged, block, contentIndex });
		stream.push({ type: "text_start", contentIndex, partial: output });
		block.text = text;
		stream.push({ type: "text_delta", contentIndex, delta: text, partial: output });
	};
	const captureContinuation = async function* (
		input: AsyncIterable<StreamEventShape>,
	): AsyncIterable<StreamEventShape> {
		for await (const event of input) {
			if (event.type === "response.created" && event.response?.id) responseId = event.response.id;
			if (event.type === "response.output_item.done" && event.item) {
				responseItems.push(event.item);
			}
			if (
				(event.type === "response.completed" || event.type === "response.incomplete")
				&& event.response
			) {
				if (event.response.id) responseId = event.response.id;
			}
			yield event;
		}
	};
	const tappedEvents = captureGeneratedImages(captureContinuation(mapCodexEvents(events, sessionKey)), {
		cwd,
		requestPrompt,
		onImageSaved: (image, imageData) => deps.onImageSaved?.(image, imageData),
		onWebSearchCaptured: updateWebSearchActivity,
	});

	await processResponsesStream(tappedEvents as AsyncIterable<never>, output, stream, model, {
		serviceTier: (options as { serviceTier?: ServiceTier } | undefined)?.serviceTier,
		resolveServiceTier: resolveCodexServiceTier,
		applyServiceTierPricing: (usage, serviceTier) =>
			applyServiceTierPricing(usage, serviceTier, model as Model<Api>, cwd),
		webSearchCitationSources,
		historicalCitationSources,
	});
	return { responseId: responseId ?? output.responseId, responseItems };
}
