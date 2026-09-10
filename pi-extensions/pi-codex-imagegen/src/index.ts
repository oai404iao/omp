import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { addPackageTool, ensureCodexServices } from "@oai404iao/pi-codex-runtime";
import { currentCodexTurn } from "@oai404iao/pi-codex-runtime/internal/codex-wire-identity";
import { loadModelSettings } from "@oai404iao/pi-codex-runtime/internal/model-catalog/runtime";
import { loadSettings } from "@oai404iao/pi-codex-runtime/internal/settings";
import { registerBackgroundImageGenerationCommand } from "./background-image-generation.js";
import { createImageGenerationToolDefinition } from "./tools/image-generation.js";
import { createImageCapture } from "./tools/image-generation/capture.js";
import { createImageDisplay } from "./tools/image-generation/display.js";

export default function codexImagegen(pi: ExtensionAPI): void {
	const broker = ensureCodexServices(pi);
	if (!broker.claim("package:imagegen")) return;
	const settings = loadSettings();
	if (!settings.enabled || !settings.imageGeneration) return;
	const display = createImageDisplay(pi);
	broker.addPresentation("image_generation", {
		clear: display.clear,
		flush: display.flush,
		scheduleFlush: display.scheduleFlush,
		registerRenderers: display.registerRenderer,
		streamEffects() {
			const sink = display.captureSink();
			return { createEventObserver: context => createImageCapture(context, sink) };
		},
	});
	addPackageTool(broker, "image_generation", () => {
		pi.registerTool(createImageGenerationToolDefinition({
			loadSettings: (cwd, model) => loadModelSettings(model, cwd),
			getCurrentTurnId: sessionId => currentCodexTurn(sessionId)?.turnId,
			hasProviderRuntime: () => broker.coreEnabled,
		}) as never);
	});
	registerBackgroundImageGenerationCommand(pi);
}
