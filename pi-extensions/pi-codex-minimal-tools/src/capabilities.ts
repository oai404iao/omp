import type { CodexMinimalToolsSettings } from "./settings.js";
import { resolveCodexRequestProfile } from "./codex-request-profile.js";

export const PACKAGE_TOOL_NAMES = ["image_generation", "view_image", "apply_patch", "web_search"] as const;
export type PackageToolName = (typeof PACKAGE_TOOL_NAMES)[number];
export const NATIVE_MUTATION_TOOL_NAMES = ["edit", "write"] as const;
export type NativeMutationToolName = (typeof NATIVE_MUTATION_TOOL_NAMES)[number];

export interface ModelLike {
	provider?: string;
	id?: string;
	name?: string;
	input?: string[];
	capabilities?: {
		input?: string[];
		inputModalities?: string[];
	};
}

export interface ToolCapability {
	enabled: boolean;
	reason: string;
}

export type ToolCapabilityMap = Record<PackageToolName, ToolCapability>;

export function modelKey(model: ModelLike | undefined): string {
	if (!model) return "no model";
	return `${model.provider ?? "unknown"}/${model.id ?? model.name ?? "unknown"}`;
}

function modelIdKey(model: ModelLike | undefined): string | undefined {
	const provider = model?.provider?.trim().toLowerCase();
	const id = model?.id?.trim().toLowerCase();
	return provider && id ? `${provider}/${id}` : undefined;
}

export function isNativeOpenAiProviderModel(model: ModelLike | undefined): boolean {
	return model?.provider === "openai" || model?.provider === "openai-codex";
}

export function isOpenAiLikeModel(model: ModelLike | undefined): boolean {
	const provider = (model?.provider ?? "").toLowerCase();
	const id = (model?.id ?? model?.name ?? "").toLowerCase();
	const openAiProvider = provider === "openai" || provider === "openai-codex" || provider === "opencode" || provider.startsWith("openai-") || provider.endsWith("-openai") || provider.endsWith("-codex");
	return openAiProvider || /^gpt[-_\d]/.test(id) || /^o\d/.test(id) || id.includes("codex");
}

export function isGpt5SeriesModel(model: ModelLike | undefined): boolean {
	const id = (model?.id ?? model?.name ?? "").toLowerCase();
	return /^gpt-5(?:$|[.-])/.test(id);
}

export function isOpenAiGpt5Model(model: ModelLike | undefined): boolean {
	return model?.provider?.toLowerCase() === "openai" && isGpt5SeriesModel(model);
}

export function isDefaultExtendedToolModel(model: ModelLike | undefined): boolean {
	const key = modelIdKey(model);
	return key !== undefined && /^openai\/gpt-5(?:$|[.-])/.test(key);
}

export function isAdditionalToolModel(model: ModelLike | undefined, additionalModelIds: readonly string[]): boolean {
	const key = modelIdKey(model);
	return Boolean(key) && additionalModelIds.some((candidate) => candidate.trim().toLowerCase() === key);
}

export function isExtendedToolModel(
	model: ModelLike | undefined,
	settings: Pick<CodexMinimalToolsSettings, "additionalModelIds">,
): boolean {
	return isDefaultExtendedToolModel(model) || isAdditionalToolModel(model, settings.additionalModelIds);
}

export function supportsImageInput(model: ModelLike | undefined): boolean {
	const inputs = [
		...(model?.input ?? []),
		...(model?.capabilities?.input ?? []),
		...(model?.capabilities?.inputModalities ?? []),
	].map((value) => value.toLowerCase());
	return inputs.includes("image") || inputs.includes("images") || inputs.includes("vision");
}

export function computeToolCapabilities(model: ModelLike | undefined, settings: CodexMinimalToolsSettings): ToolCapabilityMap {
	if (!settings.enabled) {
		return {
			image_generation: { enabled: false, reason: "package disabled" },
			view_image: { enabled: false, reason: "package disabled" },
			apply_patch: { enabled: false, reason: "package disabled" },
			web_search: { enabled: false, reason: "package disabled" },
		};
	}

	const imageInput = supportsImageInput(model);
	const openAiLike = isOpenAiLikeModel(model);
	const nativeOpenAi = isNativeOpenAiProviderModel(model);
	const extendedToolModel = isExtendedToolModel(model, settings);
	const configuredToolModel = isAdditionalToolModel(model, settings.additionalModelIds);
	const requestProfile = resolveCodexRequestProfile(settings.requestProfile);

	return {
		image_generation: openAiLike && settings.imageGeneration && settings.nativeProviderTools && requestProfile.supportsHostedTools && nativeOpenAi && imageInput
			? { enabled: true, reason: "OpenAI image-capable model with native tools enabled" }
			: openAiLike && settings.imageGeneration && settings.directImageApiFallback
				? { enabled: true, reason: "direct Images API fallback enabled" }
				: { enabled: false, reason: !openAiLike ? "model is not OpenAI/Codex-like" : !settings.imageGeneration ? "image_generation disabled by setting" : !settings.nativeProviderTools ? "native provider tools disabled" : !requestProfile.supportsHostedTools ? "hosted tools disabled by request profile" : !nativeOpenAi ? "requires openai or openai-codex provider" : "model does not advertise image input" },
		view_image: openAiLike && settings.viewImage && imageInput
			? { enabled: true, reason: "model accepts image input" }
			: { enabled: false, reason: !openAiLike ? "model is not OpenAI/Codex-like" : !settings.viewImage ? "view_image disabled by setting" : "model does not advertise image input" },
		apply_patch: settings.applyPatchEnabled && extendedToolModel
			? { enabled: true, reason: configuredToolModel ? "model enabled by additionalModelIds" : "model id starts with openai/gpt-5" }
			: {
				enabled: false,
				reason: !settings.applyPatchEnabled
					? "apply_patch disabled by setting"
					: "requires an openai/gpt-5 model or an additionalModelIds entry",
			},
		web_search: settings.webSearchEnabled && settings.nativeProviderTools && requestProfile.supportsHostedTools && nativeOpenAi && extendedToolModel
			? { enabled: true, reason: configuredToolModel ? "model enabled by additionalModelIds with native web_search" : "openai/gpt-5 model with native web_search" }
			: { enabled: false, reason: !settings.webSearchEnabled ? "web_search disabled by setting" : !settings.nativeProviderTools ? "native provider tools disabled" : !requestProfile.supportsHostedTools ? "hosted tools disabled by request profile" : !nativeOpenAi ? "requires openai or openai-codex provider" : "requires an openai/gpt-5 model or an additionalModelIds entry" },
	};
}

export function desiredPackageTools(model: ModelLike | undefined, settings: CodexMinimalToolsSettings): PackageToolName[] {
	const capabilities = computeToolCapabilities(model, settings);
	return PACKAGE_TOOL_NAMES.filter((name) => capabilities[name].enabled);
}

export interface ActiveToolSyncResult {
	activeTools: string[];
	added: string[];
	removed: string[];
	preserved: string[];
}

export function computeNextActiveTools(currentActive: readonly string[], model: ModelLike | undefined, settings: CodexMinimalToolsSettings): ActiveToolSyncResult {
	const current = new Set(currentActive);
	const desired = new Set(desiredPackageTools(model, settings));
	const added: string[] = [];
	const removed: string[] = [];

	for (const tool of PACKAGE_TOOL_NAMES) {
		if (!desired.has(tool) && current.delete(tool)) removed.push(tool);
	}

	if (settings.enabled && settings.autoEnable) {
		for (const tool of desired) {
			if (!current.has(tool)) {
				current.add(tool);
				added.push(tool);
			}
		}
	}

	if (current.has("apply_patch")) {
		for (const nativeMutationTool of NATIVE_MUTATION_TOOL_NAMES) {
			if (current.delete(nativeMutationTool)) removed.push(nativeMutationTool);
		}
	}

	const activeTools = currentActive.filter((name) => current.has(name));
	for (const name of current) if (!activeTools.includes(name)) activeTools.push(name);
	return {
		activeTools,
		added,
		removed,
		preserved: currentActive.filter((name) => !PACKAGE_TOOL_NAMES.includes(name as PackageToolName) && activeTools.includes(name)),
	};
}
