import { calculateCost, type Api, type AssistantMessage, type Model, type Usage } from "@earendil-works/pi-ai";
import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import type { OpenAIResponsesStreamOptions } from "./types.js";

export function finalizeResponseUsage(
	response: Extract<ResponseStreamEvent, { type: "response.completed" }>["response"],
	model: Model<Api>,
	output: AssistantMessage,
	options?: OpenAIResponsesStreamOptions,
): void {
	if (response?.usage) {
		const cachedTokens = response.usage.input_tokens_details?.cached_tokens || 0;
		const reasoningTokens = (response.usage as { output_tokens_details?: { reasoning_tokens?: number } }).output_tokens_details?.reasoning_tokens || 0;
		output.usage = {
			input: (response.usage.input_tokens || 0) - cachedTokens,
			output: response.usage.output_tokens || 0,
			cacheRead: cachedTokens,
			cacheWrite: 0,
			totalTokens: response.usage.total_tokens || 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		(output.usage as Usage & { reasoning?: number }).reasoning = reasoningTokens;
	}
	calculateCost(model, output.usage);
	if (options?.applyServiceTierPricing) {
		const serviceTier = options.resolveServiceTier
			? options.resolveServiceTier(response?.service_tier, options.serviceTier)
			: (response?.service_tier ?? options.serviceTier);
		options.applyServiceTierPricing(output.usage, serviceTier);
	}
	output.stopReason = mapStopReason(response?.status);
	if (output.content.some((block) => block.type === "toolCall") && output.stopReason === "stop") {
		output.stopReason = "toolUse";
	}
}

function mapStopReason(status: string | undefined): AssistantMessage["stopReason"] {
	if (!status) return "stop";
	switch (status) {
		case "completed":
			return "stop";
		case "incomplete":
			return "length";
		case "failed":
		case "cancelled":
			return "error";
		case "in_progress":
		case "queued":
			return "stop";
		default:
			throw new Error(`Unhandled stop reason: ${status}`);
	}
}
