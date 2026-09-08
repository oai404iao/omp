import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OpenAIResponsesProviderController } from "../providers/openai-codex/types.js";
import { createImageCapture } from "../tools/image-generation/capture.js";
import { createImageDisplay } from "../tools/image-generation/display.js";
import { createWebSearchCapture } from "../tools/web-search/capture.js";
import { registerWebSearchActivityRenderer } from "../tools/web-search/render.js";
import { registerResponsesProviderRuntime } from "./provider-runtime.js";

export function registerOpenAIResponsesProviders(
	pi: ExtensionAPI,
	options: { getCurrentCwd: () => string },
): OpenAIResponsesProviderController {
	const images = createImageDisplay(pi);
	return registerResponsesProviderRuntime(pi, options, {
		clear: images.clear,
		flush: images.flush,
		scheduleFlush: images.scheduleFlush,
		registerRenderers() {
			images.registerRenderer();
			registerWebSearchActivityRenderer(pi);
		},
		streamEffects() {
			const imageSink = images.captureSink();
			return {
				createEventObserver(context) {
					const imageCapture = createImageCapture(context, imageSink);
					const webSearchCapture = createWebSearchCapture(context);
					return async (event) => {
						await imageCapture(event);
						webSearchCapture(event);
					};
				},
			};
		},
	});
}
