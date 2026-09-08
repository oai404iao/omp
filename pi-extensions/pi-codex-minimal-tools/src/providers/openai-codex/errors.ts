import { type StreamEventShape } from "./types.js";

export class NonRetryableProviderError extends Error {}

export class ProviderResponseError extends Error {
	code?: string;
	errorType?: string;
	status?: number;
	retryAfterMs?: number;
}

export class ProviderProtocolError extends Error {}

export class WebSocketHandshakeError extends Error {
	constructor(
		public readonly status: number,
		message: string,
		public readonly headers: Record<string, string> = {},
		public readonly body?: string,
	) {
		super(withHttpStatusPrefix(status, message));
		this.name = "WebSocketHandshakeError";
	}
}

const HTTP_STATUS_MESSAGE_PREFIX = /^HTTP\s+\d{3}(?::|\b)/i;

export function isRetryableError(status: number, errorText: string): boolean {
	if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
		return true;
	}
	return /rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused/i.test(errorText);
}

export function withHttpStatusPrefix(status: number, message: string): string {
	const trimmed = message.trim() || "Request failed";
	if (HTTP_STATUS_MESSAGE_PREFIX.test(trimmed)) return trimmed;
	return `HTTP ${status}: ${trimmed}`;
}

export function extractWebSocketError(event: unknown): Error {
	if (event && typeof event === "object") {
		const message = "message" in event ? (event as { message?: unknown }).message : undefined;
		if (typeof message === "string" && message.length > 0) {
			return new Error(message);
		}
		const nestedError = "error" in event ? (event as { error?: unknown }).error : undefined;
		if (nestedError instanceof Error && nestedError.message.length > 0) {
			return nestedError;
		}
		if (nestedError && typeof nestedError === "object" && "message" in nestedError) {
			const nestedMessage = (nestedError as { message?: unknown }).message;
			if (typeof nestedMessage === "string" && nestedMessage.length > 0) {
				return new Error(nestedMessage);
			}
		}
	}
	return new Error("WebSocket error");
}

export function extractWebSocketCloseError(event: unknown): Error {
	if (event && typeof event === "object") {
		const code = "code" in event ? (event as { code?: unknown }).code : undefined;
		const reason = "reason" in event ? (event as { reason?: unknown }).reason : undefined;
		const codeText = typeof code === "number" ? ` ${code}` : "";
		const reasonText = typeof reason === "string" && reason.length > 0 ? ` ${reason}` : "";
		return new Error(`WebSocket closed${codeText}${reasonText}`.trim());
	}
	return new Error("WebSocket closed");
}

export function friendlyUsageLimitMessage(error: StreamEventShape["error"], status: number | undefined): string | undefined {
	const code = error?.code ?? error?.type ?? "";
	if (!/usage_limit_reached|usage_not_included/i.test(code)) {
		return undefined;
	}
	const plan = error?.plan_type ? ` (${error.plan_type.toLowerCase()} plan)` : "";
	const mins = error?.resets_at
		? Math.max(0, Math.round((error.resets_at * 1000 - Date.now()) / 60_000))
		: undefined;
	const when = mins !== undefined ? ` Try again in ~${mins} min.` : "";
	return `You have hit your OpenAI usage limit${plan}.${when}`.trim();
}

export function buildProviderErrorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const candidate = error as { code?: unknown; errorType?: unknown; status?: unknown };
	if (
		candidate?.code === "stream_read_error"
		&& candidate.errorType === "upstream_error"
	) {
		// Pi's agent-level retry classifier recognizes "connection error". Surface
		// this upstream SSE read failure in that category instead of
		// retrying inside the provider, so Pi's retry settings and UI remain the
		// single source of truth.
		return `Connection error: ${message}`;
	}
	if (/^(?:WebSocket (?:error|closed)|WebSocket stream closed before response\.completed|Stream closed before response\.completed)/.test(message)) {
		return `Connection error: ${message}`;
	}
	if (typeof candidate?.status === "number") {
		return withHttpStatusPrefix(candidate.status, message);
	}
	return message;
}

export async function parseErrorResponse(response: Response): Promise<{ message: string; friendlyMessage?: string }> {
	const raw = await response.text();
	let message = raw || response.statusText || "Request failed";
	let friendlyMessage: string | undefined;

	try {
		const parsed = JSON.parse(raw) as { error?: { code?: string; type?: string; plan_type?: string; resets_at?: number; message?: string } };
		const err = parsed?.error;
		if (err) {
			const code = err.code || err.type || "";
			if (/usage_limit_reached|usage_not_included|rate_limit_exceeded/i.test(code) || response.status === 429) {
				const plan = err.plan_type ? ` (${err.plan_type.toLowerCase()} plan)` : "";
				const mins = err.resets_at ? Math.max(0, Math.round((err.resets_at * 1000 - Date.now()) / 60000)) : undefined;
				const when = mins !== undefined ? ` Try again in ~${mins} min.` : "";
				friendlyMessage = `You have hit your ChatGPT usage limit${plan}.${when}`.trim();
			}
			message = err.message || friendlyMessage || message;
		}
	} catch {
		// ignore malformed error bodies
	}

	return { message, friendlyMessage };
}
