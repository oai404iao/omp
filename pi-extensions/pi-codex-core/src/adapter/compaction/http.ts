import { BASE_DELAY_MS, CODEX_REMOTE_COMPACTION_STREAM_RETRIES, MAX_RETRIES, SSE_RESPONSE_HEADER_TIMEOUT_MS } from "../../providers/openai-codex/constants.js";
import { NonRetryableProviderError, isRetryableError, parseErrorResponse, withHttpStatusPrefix } from "../../providers/openai-codex/errors.js";
import { proxyDispatcherForUrl } from "../../providers/openai-codex/proxy.js";
import { sleep } from "../../providers/openai-codex/retry.js";
import { fetchWithResponseHeaderTimeout } from "../../providers/openai-codex/sse.js";
import { type ResponsesBody } from "@oai404iao/pi-codex-runtime/internal/providers/openai-codex/types";
import { collectCodexCompactionOutput } from "./collect.js";

export async function postJsonWithRetries(
	url: string,
	headers: Headers,
	body: unknown,
	signal: AbortSignal | undefined,
	timeoutMs = SSE_RESPONSE_HEADER_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
	const bodyJson = JSON.stringify(body);
	const dispatcher = await proxyDispatcherForUrl(url);
	let lastError: Error | undefined;
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		try {
			const response = await fetchWithResponseHeaderTimeout(url, {
				method: "POST",
				headers,
				body: bodyJson,
				...(dispatcher ? { dispatcher } : {}),
			} as RequestInit, signal, timeoutMs);
			if (response.ok) {
				const parsed = await response.json();
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
					throw new NonRetryableProviderError("OpenAI native compaction returned a non-object response");
				}
				return parsed as Record<string, unknown>;
			}
			const errorText = await response.text();
			if (attempt < MAX_RETRIES && isRetryableError(response.status, errorText)) {
				await sleep(BASE_DELAY_MS * 2 ** attempt, signal);
				continue;
			}
			const info = await parseErrorResponse(new Response(errorText, {
				status: response.status,
				statusText: response.statusText,
			}));
			throw new NonRetryableProviderError(withHttpStatusPrefix(response.status, info.friendlyMessage || info.message));
		} catch (error) {
			if (error instanceof NonRetryableProviderError) throw error;
			if (signal?.aborted) throw new Error("Request was aborted");
			lastError = error instanceof Error ? error : new Error(String(error));
			if (attempt < MAX_RETRIES) {
				await sleep(BASE_DELAY_MS * 2 ** attempt, signal);
				continue;
			}
			throw lastError;
		}
	}
	throw lastError ?? new Error("OpenAI native compaction failed");
}

export async function requestCodexCompactionTrigger(
	url: string,
	headers: Headers,
	body: ResponsesBody,
	signal: AbortSignal | undefined,
	sessionKey?: string,
): Promise<unknown> {
	const bodyJson = JSON.stringify(body);
	const dispatcher = await proxyDispatcherForUrl(url);
	let lastError: Error | undefined;
	const maxRetries = Math.min(MAX_RETRIES, CODEX_REMOTE_COMPACTION_STREAM_RETRIES);
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			const response = await fetchWithResponseHeaderTimeout(url, {
				method: "POST",
				headers,
				body: bodyJson,
				...(dispatcher ? { dispatcher } : {}),
			} as RequestInit, signal);
			if (response.ok) return await collectCodexCompactionOutput(response, sessionKey);

			const errorText = await response.text();
			if (attempt < maxRetries && isRetryableError(response.status, errorText)) {
				await sleep(BASE_DELAY_MS * 2 ** attempt, signal);
				continue;
			}
			const info = await parseErrorResponse(new Response(errorText, {
				status: response.status,
				statusText: response.statusText,
			}));
			throw new NonRetryableProviderError(withHttpStatusPrefix(response.status, info.friendlyMessage || info.message));
		} catch (error) {
			if (error instanceof NonRetryableProviderError) throw error;
			if (signal?.aborted) throw new Error("Request was aborted");
			lastError = error instanceof Error ? error : new Error(String(error));
			if (attempt < maxRetries) {
				await sleep(BASE_DELAY_MS * 2 ** attempt, signal);
				continue;
			}
			throw lastError;
		}
	}
	throw lastError ?? new Error("OpenAI compaction trigger failed");
}
