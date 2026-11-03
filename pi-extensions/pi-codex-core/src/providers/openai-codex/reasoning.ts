import { type Api, type Context, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ResponsesBody } from "@oai404iao/pi-codex-runtime/internal/providers/openai-codex/types";

export function supportsEffortUpdates(model: Model<Api>): boolean {
	return model.reasoning && (model.compat as { supportsMidConvoEffort?: boolean } | undefined)?.supportsMidConvoEffort === true;
}

export function requestThinkingLevel(model: Model<Api>, level: ModelThinkingLevel | undefined): ModelThinkingLevel | undefined {
	// Pi encodes session Off by omitting SimpleStreamOptions.reasoning.
	return level ?? (supportsEffortUpdates(model) ? "off" : undefined);
}

export function configurationUpdateEffort(body: ResponsesBody): string | undefined {
	for (const item of [...body.input].reverse()) {
		if (item && typeof item === "object" && (item as { type?: string }).type === "configuration_update") {
			return (item as { reasoning: { effort: string } }).reasoning.effort;
		}
	}
	return undefined;
}

export function requestEffortBaseline(model: Model<Api>, context: Context, selected: string): string {
	for (const message of context.messages) {
		if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted"
			|| message.model !== model.id || message.api !== model.api || message.provider !== model.provider) continue;
		const effort = message.providerThinkingLevel;
		if (effort !== undefined) return effort;
	}
	return selected;
}

export function clampReasoningEffort(modelId: string, effort: string): string {
	const id = modelId.includes("/") ? (modelId.split("/").pop() ?? modelId) : modelId;
	const gpt5MinorMatch = /^gpt-5\.(\d+)/.exec(id);
	const gpt5Minor = gpt5MinorMatch ? Number.parseInt(gpt5MinorMatch[1], 10) : undefined;
	if (gpt5Minor !== undefined && gpt5Minor >= 2 && effort === "minimal") return "low";
	if (id === "gpt-5.1" && effort === "xhigh") return "high";
	if (id === "gpt-5.1-codex-mini") return effort === "high" || effort === "xhigh" ? "high" : "medium";
	return effort;
}

export function thinkingLevelFromUnknown(value: unknown): ModelThinkingLevel | undefined {
	return value === "off"
		|| value === "minimal"
		|| value === "low"
		|| value === "medium"
		|| value === "high"
		|| value === "xhigh"
		|| value === "max"
		? value
		: undefined;
}
