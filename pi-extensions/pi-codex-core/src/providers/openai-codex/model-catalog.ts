import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

// Astra metadata and the supplemental-provider pattern are modified from the
// Apache/MIT sources pinned in provenance/openai-codex-ddea03ad-astra.json.
export const OPENAI_CODEX_ASTRA_MODEL = {
	id: "gpt-6-astra",
	name: "GPT-6 Astra",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text", "image"],
	cost: {
		input: 10,
		output: 50,
		cacheRead: 1,
		cacheWrite: 12.5,
		tiers: [{
			inputTokensAbove: 272_000,
			input: 20,
			output: 75,
			cacheRead: 2,
			cacheWrite: 25,
		}],
	},
	contextWindow: 272_000,
	maxTokens: 128_000,
	thinkingLevelMap: {
		off: null,
		minimal: "low",
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: "max",
	},
	compat: {
		supportsOpenAIGrammarTools: true,
		supportsAdditionalTools: true,
		supportsToolSearch: true,
	},
} satisfies Model<"openai-codex-responses">;

export function appendAstraModel(
	models: readonly Model<Api>[],
): readonly Model<Api>[] {
	return models.some(model => model.id === OPENAI_CODEX_ASTRA_MODEL.id)
		? models
		: [...models, OPENAI_CODEX_ASTRA_MODEL];
}

export function createSupplementalOpenAICodexProvider(
	streamSimple: Provider["streamSimple"],
	providers: readonly Provider[] = builtinProviders(),
): Provider | undefined {
	const provider = providers.find(candidate => candidate.id === "openai-codex");
	if (!provider || provider.getModels().some(model => model.id === OPENAI_CODEX_ASTRA_MODEL.id)) {
		return undefined;
	}
	return {
		...provider,
		getModels: () => appendAstraModel(provider.getModels()),
		streamSimple,
	};
}
