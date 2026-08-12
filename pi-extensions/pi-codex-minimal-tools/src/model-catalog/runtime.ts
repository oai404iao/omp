import type { CodexRequestProfileOverride } from "../codex-request-profile.js";
import {
	loadSettings,
	type CodexMinimalToolsSettings,
} from "../settings.js";
import { resolveModelProfile } from "./catalog.js";
import type {
	ModelIdentityLike,
	ResolvedModelProfile,
	ResponsesEndpoint,
} from "./types.js";

export interface ResolvedCodexModelSettings extends CodexMinimalToolsSettings {
	modelProfile?: ResolvedModelProfile;
	modelProfileHash?: string;
	providerShimActive?: boolean;
	webSearchImplementation?: "hosted" | "standalone";
	imageGenerationImplementation?: "hosted" | "standalone";
	fastServiceTier?: string;
	fastCostMultiplier?: number;
}

function endpointUsesApiKey(endpoint: ResponsesEndpoint, model: ModelIdentityLike | undefined): boolean {
	if (endpoint === "openai") return true;
	if (endpoint === "codex") return false;
	return model?.provider !== "openai-codex";
}

export function supportsCodexResponsesApi(model: ModelIdentityLike | undefined): boolean {
	if (model?.api === "openai-responses" || model?.api === "openai-codex-responses") return true;
	if (model?.api) return false;
	return model?.provider === "openai" || model?.provider === "openai-codex";
}

export function loadModelSettings(
	model: ModelIdentityLike | undefined,
	cwd?: string,
	baseSettings = loadSettings(cwd),
): ResolvedCodexModelSettings {
	const modelProfile = resolveModelProfile(model, { settings: baseSettings });
	if (!modelProfile || !modelProfile.effective.enabled) {
		return {
			...baseSettings,
			providerShimActive: false,
			nativeProviderTools: false,
			openaiTransport: "sse",
			openaiWebSocketPrewarm: false,
			compactionMode: "pi",
			requestProfile: {
				responsesMode: "standard",
				systemPromptPlacement: "instructions",
				patchTransport: "function",
				supportsHostedTools: false,
				supportsParallelTools: true,
			},
			apiKeyMode: model?.provider !== "openai-codex",
			imageGeneration: false,
			webSearchEnabled: false,
			viewImage: false,
			applyPatchEnabled: false,
		};
	}

	const effective = modelProfile.effective;
	const packageEnabled = baseSettings.enabled;
	const providerShimActive = packageEnabled
		&& effective.responses.providerShim
		&& supportsCodexResponsesApi(model);
	const configuredWebSearchImplementation = effective.tools.webSearch
		? effective.tools.webSearch.implementation
		: undefined;
	const configuredImageGenerationImplementation = effective.tools.imageGeneration || undefined;
	const webSearchImplementation = !packageEnabled
		|| (configuredWebSearchImplementation === "hosted" && !providerShimActive)
		? undefined
		: configuredWebSearchImplementation;
	const imageGenerationImplementation = !packageEnabled
		|| (configuredImageGenerationImplementation === "hosted" && !providerShimActive)
		? undefined
		: configuredImageGenerationImplementation;
	const supportsHostedTools = webSearchImplementation === "hosted"
		|| imageGenerationImplementation === "hosted";
	const usesProviderToolRewrite = Boolean(webSearchImplementation || imageGenerationImplementation);
	const requestProfile: CodexRequestProfileOverride = {
		responsesMode: effective.responses.mode,
		systemPromptPlacement: effective.responses.systemPromptPlacement,
		patchTransport: effective.tools.applyPatch === "custom" ? "custom" : "function",
		supportsHostedTools,
		supportsParallelTools: effective.tools.parallelCalls,
	};
	return {
		...baseSettings,
		providerShimActive,
		nativeProviderTools: providerShimActive && usesProviderToolRewrite,
		openaiTransport: effective.responses.transport,
		openaiWebSocketPrewarm: effective.responses.websocketPrewarm,
		compactionMode: providerShimActive ? effective.compaction : "pi",
		requestProfile,
		apiKeyMode: endpointUsesApiKey(effective.responses.endpoint, model),
		imageGeneration: imageGenerationImplementation !== undefined,
		webSearchEnabled: webSearchImplementation !== undefined,
		viewImage: packageEnabled && effective.tools.viewImage,
		applyPatchEnabled: packageEnabled && effective.tools.applyPatch !== false,
		modelProfile,
		modelProfileHash: modelProfile.profileHash,
		webSearchImplementation,
		imageGenerationImplementation,
		fastServiceTier: providerShimActive && effective.fast ? effective.fast.serviceTier : undefined,
		fastCostMultiplier: providerShimActive && effective.fast ? effective.fast.costMultiplier : undefined,
	};
}
