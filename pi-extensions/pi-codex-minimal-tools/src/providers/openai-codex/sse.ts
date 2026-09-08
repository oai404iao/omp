import { type SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { SSE_RESPONSE_HEADER_TIMEOUT_MS } from "./constants.js";
import { type StreamEventShape } from "./types.js";

export function responseHeaderTimeoutMsFromOptions(options: SimpleStreamOptions | undefined): number {
	const value = (options as { timeoutMs?: unknown } | undefined)?.timeoutMs;
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : SSE_RESPONSE_HEADER_TIMEOUT_MS;
}

export async function fetchWithResponseHeaderTimeout(
	url: string,
	init: RequestInit,
	parentSignal: AbortSignal | undefined,
	timeoutMs = SSE_RESPONSE_HEADER_TIMEOUT_MS,
): Promise<Response> {
	if (parentSignal?.aborted) throw new Error("Request was aborted");

	const controller = new AbortController();
	let timedOut = false;
	let parentAborted = false;
	const timeoutMessage = `Codex Responses SSE response headers timed out after ${timeoutMs}ms`;

	const onParentAbort = () => {
		parentAborted = true;
		controller.abort(parentSignal?.reason);
	};

	if (parentSignal) parentSignal.addEventListener("abort", onParentAbort, { once: true });
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort(new Error(timeoutMessage));
	}, Math.max(1, timeoutMs));

	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} catch (error) {
		if (timedOut) throw new Error(timeoutMessage);
		if (parentAborted || parentSignal?.aborted) throw new Error("Request was aborted");
		throw error;
	} finally {
		clearTimeout(timeout);
		if (parentSignal) parentSignal.removeEventListener("abort", onParentAbort);
	}
}

export async function* parseSSE(response: Response): AsyncIterable<StreamEventShape> {
	if (!response.body) return;

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
			let idx = buffer.indexOf("\n\n");
			while (idx !== -1) {
				const chunk = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 2);
				const dataLines = chunk
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trim());
				if (dataLines.length > 0) {
					const data = dataLines.join("\n").trim();
					if (data && data !== "[DONE]") {
						try {
							yield JSON.parse(data) as StreamEventShape;
						} catch {
							// Ignore malformed SSE chunks and continue consuming the stream.
						}
					}
				}
				idx = buffer.indexOf("\n\n");
			}
		}
	} finally {
		try {
			await reader.cancel();
		} catch {
			// ignore cancellation errors
		}
		try {
			reader.releaseLock();
		} catch {
			// ignore lock release errors
		}
	}
}
