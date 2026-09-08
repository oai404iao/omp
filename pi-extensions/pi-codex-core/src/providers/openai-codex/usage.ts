import { type Api, type AssistantMessage, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { loadModelSettings } from "@oai404iao/pi-codex-runtime/internal/model-catalog/runtime";
import { type ServiceTier } from "@oai404iao/pi-codex-runtime/internal/providers/openai-codex/types";

function getServiceTierCostMultiplier(
	model: Model<Api>,
	serviceTier: ServiceTier,
	cwd: string,
): number {
	if (serviceTier === "flex") return 0.5;
	const settings = loadModelSettings(model, cwd);
	return serviceTier && serviceTier === settings.fastServiceTier
		? settings.fastCostMultiplier ?? 1
		: 1;
}

export function applyServiceTierPricing(
	usage: AssistantMessage["usage"],
	serviceTier: ServiceTier,
	model: Model<Api>,
	cwd: string,
): void {
	const multiplier = getServiceTierCostMultiplier(model, serviceTier, cwd);
	if (multiplier === 1) return;
	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

export function resolveCodexServiceTier(responseServiceTier: ServiceTier, requestServiceTier: ServiceTier): ServiceTier {
	if (
		responseServiceTier === "default"
		&& (requestServiceTier === "flex" || requestServiceTier === "priority")
	) {
		return requestServiceTier;
	}
	return responseServiceTier ?? requestServiceTier;
}

export function withRequestServiceTier(
	options: SimpleStreamOptions | undefined,
	serviceTier: unknown,
): SimpleStreamOptions | undefined {
	if (
		serviceTier !== "auto"
		&& serviceTier !== "default"
		&& serviceTier !== "flex"
		&& serviceTier !== "scale"
		&& serviceTier !== "priority"
	) {
		return options;
	}
	return { ...options, serviceTier } as SimpleStreamOptions;
}

export function finalizeUsage<TApi extends Api>(model: Model<TApi>, output: AssistantMessage): void {
	output.usage.cost.total = output.usage.cost.input + output.usage.cost.output + output.usage.cost.cacheRead + output.usage.cost.cacheWrite;
}
