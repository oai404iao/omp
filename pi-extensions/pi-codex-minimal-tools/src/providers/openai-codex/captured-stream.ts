import type { Api, AssistantMessage, AssistantMessageEventStream, Model, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { processResponsesStream } from "../responses/stream.js";
import type { CitationSource, WebSearchCitationSource } from "../responses/types.js";
import { mapCodexEvents } from "./events.js";
import type { ProviderStreamEffects } from "./stream-effects.js";
import type { ServiceTier, StreamEventShape } from "./types.js";
import { applyServiceTierPricing, resolveCodexServiceTier } from "./usage.js";

export async function processCapturedResponsesStream<TApi extends Api>(
	events: AsyncIterable<StreamEventShape>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<TApi>,
	options: SimpleStreamOptions | undefined,
	sessionKey: string | undefined,
	effects: ProviderStreamEffects,
	cwd: string,
	requestPrompt: string | undefined,
	webSearchCitationSources: ReadonlyArray<WebSearchCitationSource>,
	historicalCitationSources: ReadonlyArray<CitationSource>,
): Promise<{ responseId?: string; responseItems: unknown[] }> {
	const responseItems: unknown[] = [];
	let responseId: string | undefined;
	const observe = effects.createEventObserver?.({
		cwd, requestPrompt, signal: options?.signal, output, stream,
	});
	const captureContinuation = async function* (): AsyncIterable<StreamEventShape> {
		for await (const event of mapCodexEvents(events, sessionKey)) {
			if (event.type === "response.created" && event.response?.id) responseId = event.response.id;
			if (event.type === "response.output_item.done" && event.item) responseItems.push(event.item);
			if (
				(event.type === "response.completed" || event.type === "response.incomplete")
				&& event.response?.id
			) {
				responseId = event.response.id;
			}
			await observe?.(event);
			yield event;
		}
	};
	await processResponsesStream(captureContinuation() as AsyncIterable<never>, output, stream, model, {
		serviceTier: (options as { serviceTier?: ServiceTier } | undefined)?.serviceTier,
		resolveServiceTier: resolveCodexServiceTier,
		applyServiceTierPricing: (usage, serviceTier) =>
			applyServiceTierPricing(usage, serviceTier, model as Model<Api>, cwd),
		webSearchCitationSources,
		historicalCitationSources,
	});
	return { responseId: responseId ?? output.responseId, responseItems };
}
