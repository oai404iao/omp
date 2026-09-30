import { getSettingsSource, type CodexMinimalToolsSettings } from "../settings.js";
import { responsesProtocol } from "../codex-http.js";
import type { ModelIdentityLike, ResponsesEndpoint } from "./types.js";

export function requestConfigurationDiagnostics(
	model: ModelIdentityLike | undefined,
	settings: CodexMinimalToolsSettings,
	endpoint: ResponsesEndpoint = "auto",
): string[] {
	const diagnostics: string[] = [];
	if (model?.provider === "openai-codex") {
		diagnostics.push("openai-codex is deprecated compatibility only. Use /login openai and select an openai model; credentials and sessions are not migrated automatically.");
	} else {
		if (endpoint !== "auto" && endpoint !== responsesProtocol(model)) {
			diagnostics.push("responses.endpoint is deprecated and ignored outside openai-codex. Configure api and baseUrl in Pi's models.json.");
		}
		if (Object.hasOwn(getSettingsSource(settings) ?? {}, "apiKeyMode") || settings.apiKeyMode) {
			diagnostics.push("apiKeyMode is deprecated and ignored outside openai-codex. Authentication and routing follow Pi's provider configuration.");
		}
	}
	return diagnostics;
}
