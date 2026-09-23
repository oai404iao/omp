import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { addPackageTool, ensureCodexServices } from "@oai404iao/pi-codex-runtime";
import { registerCodeModeOwnedTool } from "@oai404iao/pi-codex-runtime/internal/code-mode-contributions";
import { currentCodexTurn, resolveCodexRequestIdentity } from "@oai404iao/pi-codex-runtime/internal/codex-wire-identity";
import { createWebSearchToolDefinition } from "./tools/web-search.js";
import { createWebSearchCapture } from "./tools/web-search/capture.js";
import { registerWebSearchActivityRenderer } from "./tools/web-search/render.js";
import { registerSearchContribution } from "./code-mode-adapter.js";

export default function codexWebSearch(pi: ExtensionAPI): void {
	const broker = ensureCodexServices(pi);
	if (!broker.claim("package:web-search")) return;
	registerSearchContribution(pi);
	broker.addPresentation("web_search", {
		clear() {}, flush() {}, scheduleFlush() {},
		registerRenderers: () => registerWebSearchActivityRenderer(pi),
		streamEffects: () => ({ createEventObserver: createWebSearchCapture }),
	});
	addPackageTool(broker, "web_search", () => {
		registerCodeModeOwnedTool(pi, createWebSearchToolDefinition({
			getCurrentTurnId: sessionId => currentCodexTurn(sessionId)?.turnId,
			getRequestIdentity: sessionId => resolveCodexRequestIdentity(sessionId, undefined, "turn"),
			hasProviderRuntime: () => broker.coreEnabled,
		}) as never, "codex_web");
	});
}
