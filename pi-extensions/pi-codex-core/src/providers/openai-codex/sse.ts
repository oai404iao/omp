import { type SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { SSE_RESPONSE_HEADER_TIMEOUT_MS } from "./constants.js";
import { type StreamEventShape } from "@oai404iao/pi-codex-runtime/internal/providers/openai-codex/types";
import { ProviderProtocolError } from "./errors.js";

export function responseHeaderTimeoutMsFromOptions(options: SimpleStreamOptions | undefined): number {
	const value = (options as { timeoutMs?: unknown } | undefined)?.timeoutMs;
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : SSE_RESPONSE_HEADER_TIMEOUT_MS;
}

export async function fetchWithResponseHeaderTimeout(
	url: string,
	init: RequestInit,
	parentSignal: AbortSignal | undefined,
	timeoutMs = SSE_RESPONSE_HEADER_TIMEOUT_MS,
	fetchImpl: typeof fetch = globalThis.fetch,
): Promise<Response> {
	if (parentSignal?.aborted) throw new Error("Request was aborted");

	const controller = new AbortController();
	let timedOut = false;
	const timeoutMessage = `Codex Responses SSE response headers timed out after ${timeoutMs}ms`;
	// Keep caller cancellation attached to the fetch body after headers arrive.
	const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort(new Error(timeoutMessage));
	}, Math.max(1, timeoutMs));

	try {
		return await fetchImpl(url, { ...init, signal });
	} catch (error) {
		if (timedOut) throw new Error(timeoutMessage);
		if (parentSignal?.aborted) throw new Error("Request was aborted");
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

export async function* parseSSE(response: Response, signal?: AbortSignal): AsyncIterable<StreamEventShape> {
	if (!response.body) return;

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let skipLeadingLF = false;
	const onAbort = () => { void reader.cancel().catch(() => {}); };
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		while (true) {
			if (signal?.aborted) throw new Error("Request was aborted");
			const { done, value } = await reader.read();
			if (signal?.aborted) throw new Error("Request was aborted");

			const decoded = done ? decoder.decode() : decoder.decode(value, { stream: true });
			// CR ends a line immediately; suppress its LF half if it arrives later.
			const text = skipLeadingLF && decoded.startsWith("\n") ? decoded.slice(1) : decoded;
			if (decoded) skipLeadingLF = decoded.endsWith("\r");
			buffer += text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
			if (done && buffer.trim()) buffer += "\n\n";
			let idx = buffer.indexOf("\n\n");
			while (idx !== -1) {
				if (signal?.aborted) throw new Error("Request was aborted");
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
							throw new ProviderProtocolError("Invalid Codex SSE JSON");
						}
					}
				}
				idx = buffer.indexOf("\n\n");
			}
			if (done) break;
		}
	} finally {
		signal?.removeEventListener("abort", onAbort);
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
