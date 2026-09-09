import { captureCodexTurnState } from "@oai404iao/pi-codex-runtime/internal/codex-wire-identity";
import { CODEX_RESPONSE_STATUSES } from "./constants.js";
import { ProviderResponseError, friendlyUsageLimitMessage } from "./errors.js";
import { retryAfterMsFromHeaders } from "./retry.js";
import { type StreamEventShape } from "@oai404iao/pi-codex-runtime/internal/providers/openai-codex/types";

export async function* mapCodexEvents(
	events: AsyncIterable<StreamEventShape>,
	sessionKey?: string,
): AsyncIterable<StreamEventShape> {
	let sawTerminalResponse = false;
	const completedOutputItems = new Set<string>();
	const outputItemKey = (item: unknown, index?: number): string | undefined => {
		if (!item || typeof item !== "object") return undefined;
		const candidate = item as { id?: unknown; type?: unknown };
		if (typeof candidate.id === "string" && typeof candidate.type === "string") return `${candidate.type}:${candidate.id}`;
		return typeof candidate.type === "string" && typeof index === "number" ? `${candidate.type}:index:${index}` : undefined;
	};
	for await (const event of events) {
		const type = typeof event.type === "string" ? event.type : undefined;
		if (!type) continue;

		if (type === "response.metadata" && sessionKey) {
			const eventHeaders = event.headers && typeof event.headers === "object" && !Array.isArray(event.headers)
				? (event.headers as Record<string, unknown>)
				: undefined;
			const turnState = eventHeaders?.["x-codex-turn-state"];
			if (typeof turnState === "string") {
				captureCodexTurnState(sessionKey, turnState);
			}
		}

		if (type === "error") {
			const nestedError = event.error;
			const status = typeof event.status === "number"
				? event.status
				: typeof event.status_code === "number"
					? event.status_code
					: undefined;
			const eventHeaders = event.headers && typeof event.headers === "object" && !Array.isArray(event.headers)
				? Object.fromEntries(
						Object.entries(event.headers as Record<string, unknown>)
							.filter((entry): entry is [string, string | number | boolean] =>
								typeof entry[1] === "string" || typeof entry[1] === "number" || typeof entry[1] === "boolean")
							.map(([name, value]) => [name, String(value)]),
					)
				: undefined;
			const code = typeof nestedError?.code === "string"
				? nestedError.code
				: typeof event.code === "string"
					? event.code
					: undefined;
			const message = typeof nestedError?.message === "string"
				? nestedError.message
				: typeof event.message === "string"
					? event.message
					: undefined;
			const displayMessage = friendlyUsageLimitMessage(nestedError, status)
				?? `Codex error: ${message || code || JSON.stringify(event)}`;
			const error = new ProviderResponseError(displayMessage) as ProviderResponseError & {
				sequenceNumber?: number;
			};
			if (code) error.code = code;
			if (typeof nestedError?.type === "string") error.errorType = nestedError.type;
			if (status !== undefined) error.status = status;
			error.retryAfterMs = retryAfterMsFromHeaders(eventHeaders);
			if (typeof event.sequence_number === "number") error.sequenceNumber = event.sequence_number;
			throw error;
		}

		if (type === "response.failed") {
			const responseError = event.response?.error as { code?: unknown; message?: unknown } | undefined;
			const error = new ProviderResponseError(
				typeof responseError?.message === "string" ? responseError.message : "OpenAI Responses request failed",
			);
			if (typeof responseError?.code === "string") error.code = responseError.code;
			throw error;
		}

		if (type === "response.done" || type === "response.completed" || type === "response.incomplete") {
			sawTerminalResponse = true;
			const response = event.response;
			const output = Array.isArray(response?.output) ? response.output : [];
			for (let outputIndex = 0; outputIndex < output.length; outputIndex++) {
				const item = output[outputIndex];
				if (!item || typeof item !== "object") continue;
				const itemType = (item as { type?: unknown }).type;
				if (
					itemType !== "image_generation_call"
					&& itemType !== "web_search_call"
					&& itemType !== "compaction"
					&& itemType !== "context_compaction"
				) continue;
				const key = outputItemKey(item, outputIndex);
				if (key && completedOutputItems.has(key)) continue;
				if (key) completedOutputItems.add(key);
				yield { type: "response.output_item.done", output_index: outputIndex, item } as StreamEventShape;
			}
			yield {
				...event,
				type: "response.completed",
				response: response ? { ...response, status: normalizeCodexStatus(response.status) } : response,
			};
			return;
		}

		if (type === "response.output_item.done") {
			const key = outputItemKey(event.item, typeof event.output_index === "number" ? event.output_index : undefined);
			if (key) completedOutputItems.add(key);
		}

		yield event;
	}

	if (!sawTerminalResponse) {
		throw new Error("Stream closed before response.completed");
	}
}

function normalizeCodexStatus(status: string | undefined): string | undefined {
	if (typeof status !== "string") return undefined;
	return CODEX_RESPONSE_STATUSES.has(status) ? status : undefined;
}
