import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createProviderHarness as createCoreHarness } from "../../../pi-extensions/pi-codex-core/tests/support/openai-codex-test-support.js";
import { createImageCapture } from "@oai404iao/pi-codex-imagegen/internal/tools/image-generation/capture";
import { createImageDisplay } from "@oai404iao/pi-codex-imagegen/internal/tools/image-generation/display";
import { createWebSearchCapture } from "@oai404iao/pi-codex-web-search/internal/tools/web-search/capture";
import { registerWebSearchActivityRenderer } from "@oai404iao/pi-codex-web-search/internal/tools/web-search/render";
import { registerResponsesProviderRuntime } from "@oai404iao/pi-codex-core/internal/extension/provider-runtime";

export { codexJwt } from "../../../pi-extensions/pi-codex-core/tests/support/openai-codex-test-support.js";

// Test-only adapter for transport/presentation integration, never a production owner.
function registerWithPresentation(pi: ExtensionAPI, options: { getCurrentCwd: () => string }) {
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

export function createProviderHarness(options?: Parameters<typeof createCoreHarness>[0]) {
	return createCoreHarness({ ...options, register: options?.register ?? registerWithPresentation });
}
