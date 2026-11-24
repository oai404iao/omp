import { type AssistantMessage, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import { BASE_DELAY_MS, MAX_RETRIES, DEFAULT_WEBSOCKET_STREAM_MAX_RETRIES, MAX_WEBSOCKET_STREAM_MAX_RETRIES, PREVIOUS_RESPONSE_NOT_FOUND_CODE, WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE, WEBSOCKET_RETRY_BASE_DELAY_MS, WEBSOCKET_RETRY_MAX_DELAY_MS } from "./constants.js";
import { NonRetryableProviderError, ProviderProtocolError, ProviderResponseError, WebSocketHandshakeError, buildProviderErrorMessage, isRetryableError, isTerminalQuotaError, terminalQuotaIndicator } from "./errors.js";
import { WebSocketMessageTooLargeError } from "./websocket-events.js";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Request was aborted"));
			return;
		}

		const onAbort = () => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			reject(new Error("Request was aborted"));
		};
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export function isRetryableEarlyWebSocketError(error: unknown): boolean {
	if (error instanceof NonRetryableProviderError) return false;
	const message = error instanceof Error ? error.message : String(error);
	return /^WebSocket (error|closed)(?:\s|$)/.test(message);
}

export function retryAfterMsFromHeaders(headers: Record<string, string | number> | undefined, reportOverflow = false): number | undefined {
	if (!headers) return undefined;
	const entries = Object.entries(headers);
	const decimal = /^(?:\d+(?:\.\d*)?|\.\d+)$/;
	const retryAfterMsHeader = entries.find(([name]) => name.toLowerCase() === "retry-after-ms")?.[1];
	if (reportOverflow && typeof retryAfterMsHeader === "number" && retryAfterMsHeader > Number.MAX_SAFE_INTEGER) return Infinity;
	const retryAfterMs = retryAfterMsHeader?.toString().trim();
	if (retryAfterMs && decimal.test(retryAfterMs)) {
		const parsed = Number(retryAfterMs);
		if (reportOverflow || Number.isFinite(parsed)) return parsed;
	}
	const retryAfterHeader = entries.find(([name]) => name.toLowerCase() === "retry-after")?.[1];
	if (reportOverflow && typeof retryAfterHeader === "number" && retryAfterHeader > Number.MAX_SAFE_INTEGER) return Infinity;
	const retryAfter = retryAfterHeader?.toString().trim();
	if (!retryAfter) return undefined;
	if (decimal.test(retryAfter)) {
		const delay = Number(retryAfter) * 1000;
		return reportOverflow || Number.isFinite(delay) ? delay : undefined;
	}
	// Date.parse also accepts values like "-1" that aren't HTTP dates.
	if (!/ \d{2}:\d{2}:\d{2} /.test(retryAfter)) return undefined;
	const date = Date.parse(retryAfter);
	return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

export function isRetryableWebSocketError(error: unknown): boolean {
	if (error instanceof WebSocketHandshakeError) {
		return isRetryableError(error.status, error.body ?? error.message);
	}
	if (error instanceof ProviderResponseError) {
		if (
			isTerminalQuotaError(`${error.code ?? ""} ${error.errorType ?? ""} ${error.message}`)
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

function explicitWebSocketRetryDelayMs(error: unknown, reportOverflow = false): number | undefined {
	return error instanceof WebSocketHandshakeError
		? retryAfterMsFromHeaders(error.headers, reportOverflow)
		: error instanceof ProviderResponseError
			? reportOverflow && error.retryAfterOverflow ? Infinity : error.retryAfterMs
			: undefined;
}

export function webSocketRetryAfterMs(error: unknown): number | undefined {
	return explicitWebSocketRetryDelayMs(error, true);
}

function canHonorWebSocketRetryAfter(error: unknown, output: AssistantMessage): boolean {
	if (!(error instanceof WebSocketHandshakeError || error instanceof ProviderResponseError)) return false;
	const { status } = error;
	if (status !== undefined && status !== 408 && status !== 429 && !(status >= 500 && status < 600)) return false;
	return status === 408 || isRetryableWebSocketError(error)
		|| isRetryableAssistantError({ ...output, stopReason: "error", errorMessage: buildProviderErrorMessage(error) });
}

function webSocketTerminalQuotaIndicator(error: unknown): string | undefined {
	const evidence = error instanceof WebSocketHandshakeError ? `${error.message} ${error.body ?? ""}`
		: error instanceof ProviderResponseError ? `${error.code ?? ""} ${error.errorType ?? ""} ${error.message}`
			: "";
	return terminalQuotaIndicator(evidence)
		?? /subscription_sharing_(?:usage_limit_exceeded|workplace_individual_usage_limit_exceeded)/i.exec(evidence)?.[0];
}

export type WebSocketRetryHandoff = "transient" | { quotaIndicator: string };

export async function waitForWebSocketRetryAfter(error: unknown, output: AssistantMessage, delayMs: number, signal: AbortSignal | undefined): Promise<WebSocketRetryHandoff | undefined> {
	const quotaIndicator = webSocketTerminalQuotaIndicator(error);
	if (quotaIndicator) return { quotaIndicator };
	if (!canHonorWebSocketRetryAfter(error, output)) return undefined;
	let remaining = Math.ceil(delayMs);
	if (!Number.isSafeInteger(remaining)) {
		// Never hand an unrepresentable deadline to Pi as a transient HTTP error.
		throw new NonRetryableProviderError("WebSocket Retry-After value exceeds the supported range");
	}
	// Node timers overflow above this range; a long server wait must not become an immediate retry.
	while (remaining > MAX_TIMER_DELAY_MS) {
		await sleep(MAX_TIMER_DELAY_MS, signal);
		remaining -= MAX_TIMER_DELAY_MS;
	}
	if (remaining > 0) await sleep(remaining, signal);
	return "transient";
}

function boundedRetryDelayMs(
	delayMs: number,
	options: SimpleStreamOptions | undefined,
	transport: "SSE" | "WebSocket",
): number {
	const configuredMax = options?.maxRetryDelayMs;
	const maxDelay = typeof configuredMax === "number" && Number.isFinite(configuredMax) && configuredMax >= 0
		? configuredMax
		: WEBSOCKET_RETRY_MAX_DELAY_MS;
	if (maxDelay > 0 && delayMs > maxDelay) {
		throw new NonRetryableProviderError(
			`${transport} retry delay ${Math.round(delayMs)}ms exceeds maxRetryDelayMs ${Math.round(maxDelay)}ms`,
		);
	}
	if (delayMs > MAX_TIMER_DELAY_MS) {
		throw new NonRetryableProviderError(`${transport} retry delay exceeds Node.js timer range`);
	}
	return delayMs;
}

export function sseMaxRetries(options: SimpleStreamOptions | undefined): number {
	const value = options?.maxRetries;
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : MAX_RETRIES;
}

export function sseRetryDelayMs(
	attempt: number,
	options: SimpleStreamOptions | undefined,
	retryAfter?: number | Record<string, string>,
): number {
	const delay = (typeof retryAfter === "number" ? retryAfter : retryAfterMsFromHeaders(retryAfter)) ?? BASE_DELAY_MS * 2 ** attempt;
	return boundedRetryDelayMs(delay, options, "SSE");
}

export function webSocketRetryDelayMs(
	error: unknown,
	retryCount: number,
	options: SimpleStreamOptions | undefined,
): number {
	const connectionFailure = !(
		error instanceof WebSocketHandshakeError
		|| error instanceof ProviderResponseError
		|| error instanceof ProviderProtocolError
	);
	const delay = connectionFailure
		? Math.min(WEBSOCKET_RETRY_MAX_DELAY_MS, 5_000 * 2 ** Math.max(0, retryCount - 1))
		: Math.round(WEBSOCKET_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, retryCount - 1) * (0.9 + Math.random() * 0.2));
	return boundedRetryDelayMs(delay, options, "WebSocket");
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
	return boundedRetryDelayMs(jittered, options, "WebSocket");
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
	return error instanceof WebSocketHandshakeError && error.status === 426;
}

export function webSocketSseFallbackPhase(error: unknown): "websocket_upgrade_rejected" | "websocket_message_too_large" | undefined {
	if (isWebSocketUpgradeRejectedError(error)) return "websocket_upgrade_rejected";
	if (error instanceof WebSocketMessageTooLargeError && error.beforeResponseText) return "websocket_message_too_large";
	return undefined;
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
