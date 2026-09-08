import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OpenAIResponsesProviderController } from "@oai404iao/pi-codex-runtime/internal/providers/openai-codex/types";
import { createImageCapture } from "@oai404iao/pi-codex-imagegen/internal/tools/image-generation/capture";
import { createImageDisplay } from "@oai404iao/pi-codex-imagegen/internal/tools/image-generation/display";
import { createWebSearchCapture } from "@oai404iao/pi-codex-web-search/internal/tools/web-search/capture";
import { registerWebSearchActivityRenderer } from "@oai404iao/pi-codex-web-search/internal/tools/web-search/render";
import { registerResponsesProviderRuntime } from "@oai404iao/pi-codex-core/internal/extension/provider-runtime";

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
