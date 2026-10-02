import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { addPackageTool, ensureCodexServices } from "@oai404iao/pi-codex-runtime";
import { currentCodexTurn, resolveCodexRequestIdentity } from "@oai404iao/pi-codex-runtime/internal/codex-wire-identity";
import { createWebSearchToolDefinition } from "./tools/web-search.js";
import { createWebSearchCapture } from "./tools/web-search/capture.js";
import { registerWebSearchActivityRenderer } from "./tools/web-search/render.js";
import { loadSettings } from "@oai404iao/pi-codex-runtime/internal/settings";

export default function codexWebSearch(pi: ExtensionAPI): void {
	const broker = ensureCodexServices(pi);
	if (!broker.claim("package:web-search")) return;
	broker.addPresentation("web_search", {
		clear() {}, flush() {}, scheduleFlush() {},
		registerRenderers: () => registerWebSearchActivityRenderer(pi),
		streamEffects: () => ({ createEventObserver: createWebSearchCapture }),
	});
	const definition = createWebSearchToolDefinition({
		getCurrentTurnId: sessionId => currentCodexTurn(sessionId)?.turnId,
		getRequestIdentity: sessionId => loadSettings().codexRequestExtensions ? resolveCodexRequestIdentity(sessionId, undefined, "turn") : undefined,
		hasProviderRuntime: () => broker.coreEnabled,
	});
	const parameters = { ...definition.parameters };
	broker.ownedTools.set("web_search", { parameters, description: definition.description });
	addPackageTool(broker, "web_search", exposure => {
		pi.registerTool({ ...definition, parameters, exposure } as never);
	});
}
