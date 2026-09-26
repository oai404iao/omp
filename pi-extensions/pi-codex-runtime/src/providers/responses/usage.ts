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
		const cacheWriteTokens = (response.usage.input_tokens_details as { cache_write_tokens?: number } | undefined)?.cache_write_tokens || 0;
		const reasoningTokens = (response.usage as { output_tokens_details?: { reasoning_tokens?: number } }).output_tokens_details?.reasoning_tokens || 0;
		output.usage = {
			input: Math.max(0, (response.usage.input_tokens || 0) - cachedTokens - cacheWriteTokens),
			output: response.usage.output_tokens || 0,
			cacheRead: cachedTokens,
			cacheWrite: cacheWriteTokens,
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
	const incompleteReason = response?.status === "incomplete" ? response.incomplete_details?.reason : undefined;
	output.rawStopReason = incompleteReason ? `${response.status}.${incompleteReason}` : response?.status;
	const terminal = mapStopReason(response?.status, incompleteReason);
	output.stopReason = terminal.stopReason;
	if (terminal.errorMessage) output.errorMessage = response?.error?.message || terminal.errorMessage;
	else delete output.errorMessage;
	if (output.content.some((block) => block.type === "toolCall") && output.stopReason === "stop") {
		output.stopReason = "toolUse";
	}
}

function mapStopReason(
	status: string | undefined,
	incompleteReason: string | undefined,
): { stopReason: AssistantMessage["stopReason"]; errorMessage?: string } {
	if (!status) return { stopReason: "stop" };
	switch (status) {
		case "completed":
			return { stopReason: "stop" };
		case "incomplete":
			return incompleteReason === "max_output_tokens"
				? { stopReason: "length" }
				: {
						stopReason: "error",
						errorMessage: incompleteReason ? `Response incomplete: ${incompleteReason}` : "Response incomplete without a provider reason",
					};
		case "failed":
		case "cancelled":
			return { stopReason: "error", errorMessage: `Response ${status}` };
		case "in_progress":
		case "queued":
			return { stopReason: "error", errorMessage: `Response ended with non-terminal status: ${status}` };
		default:
			throw new Error(`Unhandled stop reason: ${status}`);
	}
}
