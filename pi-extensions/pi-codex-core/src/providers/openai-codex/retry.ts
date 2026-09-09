import { type SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { DEFAULT_WEBSOCKET_STREAM_MAX_RETRIES, MAX_WEBSOCKET_STREAM_MAX_RETRIES, PREVIOUS_RESPONSE_NOT_FOUND_CODE, WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE, WEBSOCKET_RETRY_BASE_DELAY_MS, WEBSOCKET_RETRY_MAX_DELAY_MS } from "./constants.js";
import { NonRetryableProviderError, ProviderProtocolError, ProviderResponseError, WebSocketHandshakeError, isRetryableError } from "./errors.js";

export function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Request was aborted"));
			return;
		}

		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(new Error("Request was aborted"));
			},
			{ once: true },
		);
	});
}

export function isRetryableEarlyWebSocketError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /^WebSocket (error|closed)(?:\s|$)/.test(message);
}

export function retryAfterMsFromHeaders(headers: Record<string, string> | undefined): number | undefined {
	if (!headers) return undefined;
	const retryAfterMs = Object.entries(headers).find(([name]) => name.toLowerCase() === "retry-after-ms")?.[1];
	if (retryAfterMs) {
		const parsed = Number.parseFloat(retryAfterMs);
		if (Number.isFinite(parsed) && parsed >= 0) return parsed;
	}
	const retryAfter = Object.entries(headers).find(([name]) => name.toLowerCase() === "retry-after")?.[1];
	if (!retryAfter) return undefined;
	const seconds = Number.parseFloat(retryAfter);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
	const date = Date.parse(retryAfter);
	return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

export function isRetryableWebSocketError(error: unknown): boolean {
	if (error instanceof WebSocketHandshakeError) {
		return isRetryableError(error.status, error.body ?? error.message);
	}
	if (error instanceof ProviderResponseError) {
		if (
			/usage_limit_reached|usage_not_included/i.test(`${error.code ?? ""} ${error.errorType ?? ""}`)
		) {
			return false;
		}
		if (typeof error.status === "number" && isRetryableError(error.status, error.message)) return true;
		return /retry|rate.?limit|overloaded|service.?unavailable|connection.?limit/i.test(
			`${error.code ?? ""} ${error.errorType ?? ""} ${error.message}`,
		);
	}
	if (error instanceof ProviderProtocolError || error instanceof NonRetryableProviderError) return false;
	const message = error instanceof Error ? error.message : String(error);
	return /websocket|network|connection|socket|timed? out|timeout|fetch failed|terminated|closed before response\.completed|stream closed before response\.completed/i.test(
		message,
	);
}

function explicitWebSocketRetryDelayMs(error: unknown): number | undefined {
	return error instanceof WebSocketHandshakeError
		? retryAfterMsFromHeaders(error.headers)
		: error instanceof ProviderResponseError
			? error.retryAfterMs
			: undefined;
}

function boundedWebSocketRetryDelayMs(
	delayMs: number,
	options: SimpleStreamOptions | undefined,
): number {
	const configuredMax = options?.maxRetryDelayMs;
	const maxDelay = typeof configuredMax === "number" && Number.isFinite(configuredMax) && configuredMax >= 0
		? configuredMax
		: WEBSOCKET_RETRY_MAX_DELAY_MS;
	if (maxDelay > 0 && delayMs > maxDelay) {
		throw new NonRetryableProviderError(
			`WebSocket retry delay ${Math.round(delayMs)}ms exceeds maxRetryDelayMs ${Math.round(maxDelay)}ms`,
		);
	}
	return delayMs;
}

export function webSocketRetryDelayMs(
	error: unknown,
	retryCount: number,
	options: SimpleStreamOptions | undefined,
): number {
	const explicit = explicitWebSocketRetryDelayMs(error);
	const connectionFailure = !(
		error instanceof WebSocketHandshakeError
		|| error instanceof ProviderResponseError
		|| error instanceof ProviderProtocolError
	);
	const base = explicit
		?? (connectionFailure
			? Math.min(WEBSOCKET_RETRY_MAX_DELAY_MS, 5_000 * 2 ** Math.max(0, retryCount - 1))
			: WEBSOCKET_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, retryCount - 1));
	const jittered = explicit === undefined && !connectionFailure
		? Math.round(base * (0.9 + Math.random() * 0.2))
		: base;
	return boundedWebSocketRetryDelayMs(jittered, options);
}

export function webSocketCompactionRetryDelayMs(
	error: unknown,
	retryCount: number,
	options: SimpleStreamOptions | undefined,
): number {
	const explicit = explicitWebSocketRetryDelayMs(error);
	const base = explicit ?? WEBSOCKET_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, retryCount - 1);
	const jittered = explicit === undefined
		? Math.round(base * (0.9 + Math.random() * 0.2))
		: base;
	return boundedWebSocketRetryDelayMs(jittered, options);
}

export function webSocketStreamMaxRetries(options: SimpleStreamOptions | undefined): number {
	const value = options?.maxRetries;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return DEFAULT_WEBSOCKET_STREAM_MAX_RETRIES;
	}
	return Math.min(MAX_WEBSOCKET_STREAM_MAX_RETRIES, Math.floor(value));
}

export function isProviderNonTransportError(error: unknown): error is ProviderResponseError | ProviderProtocolError {
	return error instanceof ProviderResponseError || error instanceof ProviderProtocolError;
}

export function isWebSocketUpgradeRejectedError(error: unknown): error is WebSocketHandshakeError {
	// `auto` is capability negotiation, not a generic recovery path. HTTP 426
	// explicitly tells the client that the WebSocket upgrade cannot be used.
	// Model/request failures and transient connection errors must stay on the
	// WebSocket path so an agent-level retry does not silently change transport.
	return error instanceof WebSocketHandshakeError && error.status === 426;
}

export function isWebSocketConnectionLimitReachedError(error: unknown): boolean {
	const candidate = error as { code?: unknown; message?: unknown };
	if (candidate?.code === WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE) return true;
	return typeof candidate?.message === "string" && candidate.message.includes(WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE);
}

export function isPreviousResponseNotFoundError(error: unknown): boolean {
	const candidate = error as { code?: unknown; message?: unknown };
	if (candidate?.code === PREVIOUS_RESPONSE_NOT_FOUND_CODE) return true;
	return typeof candidate?.message === "string" && candidate.message.includes(PREVIOUS_RESPONSE_NOT_FOUND_CODE);
}
