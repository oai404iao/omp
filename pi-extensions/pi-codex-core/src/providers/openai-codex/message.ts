import { type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai/compat";
import { buildProviderErrorMessage, ProviderResponseError } from "./errors.js";

export function createInitialAssistantMessage<TApi extends Api>(model: Model<TApi>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

export function assertSuccessfulOutput(
	message: AssistantMessage,
): asserts message is AssistantMessage & { stopReason: "stop" | "length" | "toolUse" } {
	if (message.stopReason !== "stop" && message.stopReason !== "length" && message.stopReason !== "toolUse") {
		throw new ProviderResponseError(message.errorMessage || `Codex stream ended with stop reason: ${message.stopReason}`);
	}
}

export function createErrorMessage(message: AssistantMessage, error: unknown, aborted: boolean): AssistantMessage {
	for (const block of message.content) {
		if (typeof block === "object" && block !== null && "partialJson" in block) {
			delete (block as { partialJson?: string }).partialJson;
		}
	}
	message.stopReason = aborted ? "aborted" : "error";
	message.errorMessage = buildProviderErrorMessage(error);
	return message;
}
