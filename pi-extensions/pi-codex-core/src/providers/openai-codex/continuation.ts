import { type CachedWebSocketContinuationState, type ResponsesBody, type SessionWebSocketCacheEntry } from "@oai404iao/pi-codex-runtime/internal/providers/openai-codex/types";

function requestBodyWithoutInput(body: ResponsesBody): ResponsesBody {
	const {
		input: _input,
		previous_response_id: _previousResponseId,
		client_metadata: _clientMetadata,
		stream_options: _streamOptions,
		generate: _generate,
		...rest
	} = body;
	return rest as ResponsesBody;
}

function normalizeResponseItemForComparison(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalizeResponseItemForComparison);
	if (!value || typeof value !== "object") return value;
	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (key === "internal_chat_message_metadata_passthrough") continue;
		result[key] = normalizeResponseItemForComparison(entry);
	}
	return result;
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "undefined";
}

function responseInputsEqual(a: unknown[] | undefined, b: unknown[] | undefined): boolean {
	const left = a ?? [];
	const right = b ?? [];
	if (left.length !== right.length) return false;
	return left.every((item, index) =>
		stableJson(normalizeResponseItemForComparison(item))
		=== stableJson(normalizeResponseItemForComparison(right[index])));
}

function requestBodiesMatchExceptInput(a: ResponsesBody, b: ResponsesBody): boolean {
	return stableJson(requestBodyWithoutInput(a)) === stableJson(requestBodyWithoutInput(b));
}

function getCachedWebSocketInputDelta(body: ResponsesBody, continuation: CachedWebSocketContinuationState): unknown[] | undefined {
	if (!requestBodiesMatchExceptInput(body, continuation.lastRequestBody)) {
		return undefined;
	}

	const currentInput = body.input ?? [];
	const baseline = [...(continuation.lastRequestBody.input ?? []), ...continuation.lastResponseItems];
	if (currentInput.length < baseline.length) {
		return undefined;
	}

	const prefix = currentInput.slice(0, baseline.length);
	if (!responseInputsEqual(prefix, baseline)) {
		return undefined;
	}

	return currentInput.slice(baseline.length);
}

export function buildCachedWebSocketRequestBody(
	entry: SessionWebSocketCacheEntry,
	body: ResponsesBody,
): ResponsesBody {
	const continuation = entry.continuation;
	if (!continuation) {
		return body;
	}

	const delta = getCachedWebSocketInputDelta(body, continuation);
	if (delta === undefined || !continuation.lastResponseId) {
		entry.continuation = undefined;
		return body;
	}
	return {
		...body,
		previous_response_id: continuation.lastResponseId,
		input: delta,
	};
}

function isPrefixedResponseItemId(value: string): boolean {
	const separator = value.indexOf("_");
	return separator > 0 && separator < value.length - 1;
}

function prepareResponseItemsForWire(items: unknown[]): unknown[] {
	return items.map((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return item;
		const record = item as Record<string, unknown>;
		if (typeof record.id !== "string" || isPrefixedResponseItemId(record.id)) return item;
		const { id: _id, ...rest } = record;
		return rest;
	});
}

export function prepareWebSocketRequestBodyForWire(body: ResponsesBody): ResponsesBody {
	return {
		...body,
		input: prepareResponseItemsForWire(body.input ?? []),
	};
}
