import type { ModelLike } from "./capabilities.js";
import { listResolvedModelProfiles, resolveModelProfile } from "./model-catalog/catalog.js";
import type { CodexMinimalToolsSettings } from "./settings.js";

export interface ModelRegistryLike {
	getAll?: () => unknown;
	getAvailable?: () => unknown;
	find?: (provider: string, id: string) => unknown;
}

export interface ActivationContextLike {
	model?: ModelLike;
	modelRegistry?: ModelRegistryLike;
}

export function registryModels(registry: ModelRegistryLike | undefined): ModelLike[] {
	if (!registry) return [];
	for (const method of [registry.getAll, registry.getAvailable]) {
		if (typeof method !== "function") continue;
		try {
			const value = method.call(registry);
			if (Array.isArray(value)) return value.filter((model): model is ModelLike => Boolean(model) && typeof model === "object");
		} catch {
			// Try the next registry shape.
		}
	}
	return [];
}

export function hasConfiguredModelsLoaded(
	ctx: ActivationContextLike,
	settings?: CodexMinimalToolsSettings,
): boolean {
	const current = resolveModelProfile(ctx.model, { settings });
	if (current?.effective.enabled) return true;
	const configured = new Set(
		listResolvedModelProfiles({ settings })
			.filter((profile) => profile.effective.enabled)
			.map((profile) => profile.id.toLowerCase()),
	);
	if (registryModels(ctx.modelRegistry).some((model) => {
		const provider = model.provider?.trim().toLowerCase();
		const id = model.id?.trim().toLowerCase();
		return Boolean(provider && id && configured.has(`${provider}/${id}`));
	})) {
		return true;
	}
	try {
		return [...configured].some((fullId) => {
			const slash = fullId.indexOf("/");
			return Boolean(ctx.modelRegistry?.find?.(fullId.slice(0, slash), fullId.slice(slash + 1)));
		});
	} catch {
		return false;
	}
}
