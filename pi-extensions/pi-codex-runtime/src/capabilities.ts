import type { CodexMinimalToolsSettings } from "./settings.js";
import { loadModelSettings } from "./model-catalog/runtime.js";

export const PACKAGE_TOOL_NAMES = ["image_generation", "view_image", "apply_patch", "web_search"] as const;
export type PackageToolName = (typeof PACKAGE_TOOL_NAMES)[number];
export const NATIVE_MUTATION_TOOL_NAMES = ["edit", "write"] as const;
export type NativeMutationToolName = (typeof NATIVE_MUTATION_TOOL_NAMES)[number];

export interface ModelLike {
	provider?: string;
	id?: string;
	name?: string;
	api?: string;
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

	const modelSettings = loadModelSettings(model, undefined, settings);
	const profile = modelSettings.modelProfile?.effective;
	if (!profile || !profile.enabled) {
		return {
			image_generation: { enabled: false, reason: "model has no enabled model catalog profile" },
			view_image: { enabled: false, reason: "model has no enabled model catalog profile" },
			apply_patch: { enabled: false, reason: "model has no enabled model catalog profile" },
			web_search: { enabled: false, reason: "model has no enabled model catalog profile" },
		};
	}

	const imageInput = supportsImageInput(model);
	const imageGeneration = profile.tools.imageGeneration;
	const webSearch = profile.tools.webSearch;
	const providerShimActive = modelSettings.providerShimActive;

	return {
		image_generation: imageGeneration === "hosted" && providerShimActive && imageInput
			? { enabled: true, reason: "model profile enables hosted image_generation" }
			: imageGeneration === "standalone" && imageInput
				? { enabled: true, reason: "model profile enables standalone image generation" }
				: profile.tools.imageGeneration !== false && settings.directImageApiFallback
				? { enabled: true, reason: "direct Images API fallback enabled" }
				: { enabled: false, reason: imageGeneration === false ? "image_generation disabled by model profile" : "model does not advertise image input" },
		view_image: profile.tools.viewImage && imageInput
			? { enabled: true, reason: "model profile enables view_image and model accepts image input" }
			: { enabled: false, reason: !profile.tools.viewImage ? "view_image disabled by model profile" : "model does not advertise image input" },
		apply_patch: profile.tools.applyPatch === "custom" && !providerShimActive
			? {
				enabled: false,
				reason: "custom apply_patch requires an OpenAI Responses provider shim API",
			}
			: profile.tools.applyPatch
			? { enabled: true, reason: `model profile enables ${profile.tools.applyPatch} apply_patch` }
			: {
				enabled: false,
				reason: "apply_patch disabled by model profile",
			},
		web_search: webSearch && (webSearch.implementation === "standalone" || providerShimActive)
			? { enabled: true, reason: `model profile enables ${webSearch.implementation} web search` }
			: {
				enabled: false,
				reason: webSearch !== false && webSearch.implementation === "hosted"
					? "hosted web_search requires an OpenAI Responses provider shim API"
					: "web_search disabled by model profile",
			},
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
