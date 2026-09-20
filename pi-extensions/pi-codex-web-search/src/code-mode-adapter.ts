import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerCodeModeContribution, type OwnedCodeModeTool } from "@oai404iao/pi-codex-runtime/internal/code-mode-contributions";
import { loadModelSettings } from "@oai404iao/pi-codex-runtime/internal/model-catalog/runtime";
import { standaloneWebSearch, webSearchToolSchema, type WebSearchInput } from "./tools/web-search.js";

export function registerSearchContribution(pi: ExtensionAPI): void {
	const enabled = (ctx: ExtensionContext) => {
		const settings = loadModelSettings(ctx.model, ctx.cwd);
		return settings.enabled && settings.webSearchImplementation === "standalone";
	};
	const tool: OwnedCodeModeTool = {
		name: "web_search", effect: "read", parallel: true,
		description: "Run the installed Codex standalone alpha/search client with the current model/profile and Pi credentials. Returns text and structured results to JavaScript. Sends the owner's bounded recent conversation tail. Hosted placeholders are never executed; Pi direct tool hooks are not inherited.",
		parameters: webSearchToolSchema,
		async invoke(input, ctx) {
			ctx.signal.throwIfAborted();
			if (!ctx.pi || !enabled(ctx.pi)) throw new Error("Only an enabled Codex standalone search profile can be nested; hosted search stays direct");
			const result = await standaloneWebSearch(input as WebSearchInput, ctx.pi, ctx.signal);
			return { value: { text: result.content.map((part) => part.text).join("\n"), results: result.details.results } };
		},
	};
	registerCodeModeContribution(pi, "codex_web", (ctx) => enabled(ctx) ? [tool] : []);
}
