import type { CodexRequestProfileOverride } from "../codex-request-profile.js";
import { responsesProtocol, type ResponsesProtocol } from "../codex-http.js";
import {
	loadSettings,
	getSettingsSource,
	type CodexMinimalToolsSettings,
} from "../settings.js";
import { resolveModelProfile } from "./catalog.js";
import { requestConfigurationDiagnostics } from "./request-diagnostics.js";
import { endpointDeclares, type EndpointCapability } from "../endpoint-config.js";
import { endpointWasRejected } from "../endpoint-state.js";
import { sessionFastMode } from "../fast-mode-state.js";
import type {
	ModelIdentityLike,
	ResolvedModelProfile,
} from "./types.js";

export interface ResolvedCodexModelSettings extends CodexMinimalToolsSettings {
	responsesEndpoint: ResponsesProtocol;
	requestDiagnostics: string[];
	requestBlockedReason?: string;
	endpointDisabledWebSearch?: boolean;
	modelProfile?: ResolvedModelProfile;
	modelProfileHash?: string;
	providerShimActive?: boolean;
	webSearchImplementation?: "hosted" | "standalone";
	imageGenerationImplementation?: "standalone";
	fastServiceTier?: string;
	fastCostMultiplier?: number;
}

export function supportsCodexResponsesApi(model: ModelIdentityLike | undefined): boolean {
	if (model?.api === "openai-responses" || model?.api === "openai-codex-responses") return true;
	if (model?.api) return false;
	return model?.provider === "openai" || model?.provider === "openai-codex";
}

function resolveModelSettings(
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
				reasoningSummary: "auto",
			systemPromptPlacement: "developer",
				patchTransport: "function",
				supportsHostedTools: false,
				supportsParallelTools: true,
			},
			responsesEndpoint: responsesProtocol(model),
			requestDiagnostics: requestConfigurationDiagnostics(model, baseSettings),
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
	const configuredImageGenerationImplementation = baseSettings.imageGeneration
		? effective.tools.imageGeneration || undefined
		: undefined;
	const webSearchImplementation = !packageEnabled
		|| (configuredWebSearchImplementation === "hosted" && !providerShimActive)
		? undefined
		: configuredWebSearchImplementation;
	const imageGenerationImplementation = packageEnabled ? configuredImageGenerationImplementation : undefined;
	const supportsHostedTools = webSearchImplementation === "hosted";
	const usesProviderToolRewrite = Boolean(webSearchImplementation || imageGenerationImplementation);
	const requestProfile: CodexRequestProfileOverride = {
		responsesMode: effective.responses.mode,
		reasoningSummary: effective.responses.reasoningSummary,
		systemPromptPlacement: effective.responses.systemPromptPlacement,
		patchTransport: effective.tools.applyPatch === "custom" ? "custom" : "function",
		supportsHostedTools,
		supportsParallelTools: effective.tools.parallelCalls,
	};
	return {
		...baseSettings,
		providerShimActive,
		nativeProviderTools: providerShimActive && usesProviderToolRewrite,
		openaiTransport: baseSettings.webSocketEnabled
			? effective.responses.transport
			: "sse",
		openaiWebSocketPrewarm:
			baseSettings.webSocketEnabled
			&& effective.responses.websocketPrewarm,
		compactionMode: providerShimActive ? effective.compaction : "pi",
		requestProfile,
		responsesEndpoint: responsesProtocol(model, effective.responses.endpoint),
		requestDiagnostics: requestConfigurationDiagnostics(model, baseSettings, effective.responses.endpoint),
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

export function loadModelSettings(
	model: ModelIdentityLike | undefined,
	cwd?: string,
	baseSettings = loadSettings(cwd),
	sessionId?: string,
): ResolvedCodexModelSettings {
	const resolved = resolveModelSettings(model, cwd, baseSettings);
	if (getSettingsSource(baseSettings)?.compactionMode === "responses-compact") {
		resolved.compactionMode = "pi";
		resolved.openaiWebSocketPrewarm = false;
		resolved.requestBlockedReason = "compactionMode responses-compact was removed. Select responses or pi explicitly; historical checkpoint protection remains active.";
		resolved.requestDiagnostics.push(resolved.requestBlockedReason);
	}
	return applyEndpointPolicy(resolved, model, sessionId);
}

export function applyEndpointPolicy(
	resolved: ResolvedCodexModelSettings, model: ModelIdentityLike | undefined, sessionId?: string,
): ResolvedCodexModelSettings {
	const settings = { ...resolved, requestDiagnostics: [...resolved.requestDiagnostics] };
	settings.fastMode = sessionFastMode(sessionId, settings.fastMode);
	const allows = (capability: EndpointCapability): boolean => {
		if (endpointDeclares(settings.endpoint_config, model ?? {}, capability)
			&& !endpointWasRejected(model ?? {}, sessionId, capability)) return true;
		settings.requestDiagnostics.push(`${capability} is disabled by endpoint_config or an explicit rejection in this session; no implementation fallback was selected.`);
		return false;
	};
	if (settings.webSearchImplementation && !allows(`webSearch.${settings.webSearchImplementation}`)) {
		settings.endpointDisabledWebSearch = true;
		settings.webSearchImplementation = undefined;
		settings.webSearchEnabled = false;
	}
	if (settings.imageGenerationImplementation && !allows(`imageGeneration.${settings.imageGenerationImplementation}`)) {
		settings.imageGenerationImplementation = undefined;
		settings.imageGeneration = false;
	}
	if (settings.compactionMode !== "pi" && !allows(`compaction.${settings.compactionMode}`)) {
		settings.compactionMode = "pi";
	}
	if (!settings.codexRequestExtensions) {
		if (!settings.modelProfileHash?.endsWith(":wire-off")) settings.modelProfileHash = `${settings.modelProfileHash ?? "native"}:wire-off`;
		if (settings.requestProfile.responsesMode === "lite" && settings.providerShimActive) {
			settings.requestBlockedReason = "Responses Lite requires codexRequestExtensions:true. Select a Standard profile or re-enable the setting.";
			settings.requestDiagnostics.push(settings.requestBlockedReason);
			settings.openaiWebSocketPrewarm = false;
		}
		if (settings.compactionMode !== "pi") {
			settings.requestDiagnostics.push("Native compaction is disabled by codexRequestExtensions:false; existing opaque checkpoints are protected.");
			settings.compactionMode = "pi";
		}
	}
	settings.requestProfile = { ...settings.requestProfile,
		supportsHostedTools: settings.webSearchImplementation === "hosted" };
	return settings;
}
