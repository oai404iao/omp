import { CODEX_REMOTE_COMPACTION_STREAM_RETRIES, MAX_RETRIES } from "../../providers/openai-codex/constants.js";
import { NonRetryableProviderError, ProviderProtocolError, ProviderResponseError, isRetryableError, isTerminalQuotaError, parseErrorResponse, withHttpStatusPrefix } from "../../providers/openai-codex/errors.js";
import { proxyDispatcherForUrl } from "../../providers/openai-codex/proxy.js";
import { sleep, sseRetryDelayMs } from "../../providers/openai-codex/retry.js";
import { fetchWithResponseHeaderTimeout } from "../../providers/openai-codex/sse.js";
import { type ResponsesBody } from "@oai404iao/pi-codex-runtime/internal/providers/openai-codex/types";
import { collectCodexCompactionOutput } from "./collect.js";
import { unsupportedEndpointCapabilities } from "@oai404iao/pi-codex-runtime/internal/endpoint-state";
import { prepareSseBody } from "../../providers/openai-codex/request-compression.js";

export async function requestCodexCompactionTrigger(
	url: string,
	headers: Headers,
	body: ResponsesBody,
	signal: AbortSignal | undefined,
	options: { sessionKey?: string; provider?: string; maxRetryDelayMs?: number } = {},
): Promise<unknown> {
	const bodyJson = prepareSseBody(url, JSON.stringify(body), headers, options.provider);
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
			if (response.ok) return await collectCodexCompactionOutput(response, options.sessionKey, signal);

			const errorText = await response.text();
			if (attempt < maxRetries && isRetryableError(response.status, errorText)
				&& !unsupportedEndpointCapabilities(["compaction.responses"], { status: response.status, responseBody: errorText }).length) {
				await sleep(sseRetryDelayMs(attempt, options, Object.fromEntries(response.headers)), signal);
				continue;
			}
			const info = await parseErrorResponse(new Response(errorText, {
				status: response.status,
				statusText: response.statusText,
			}));
			throw Object.assign(new NonRetryableProviderError(withHttpStatusPrefix(response.status, info.friendlyMessage || info.message)),
				{ status: response.status, responseBody: errorText });
		} catch (error) {
			if (error instanceof NonRetryableProviderError || error instanceof ProviderProtocolError) throw error;
			if (error instanceof ProviderResponseError && isTerminalQuotaError(`${error.code ?? ""} ${error.errorType ?? ""} ${error.message}`)) throw error;
			if (error instanceof ProviderResponseError && /^unsupported_/.test(error.code ?? "")) throw error;
			if (signal?.aborted) throw new Error("Request was aborted");
			lastError = error instanceof Error ? error : new Error(String(error));
			if (attempt < maxRetries) {
				const retryAfterMs = error instanceof ProviderResponseError ? error.retryAfterMs : undefined;
				await sleep(sseRetryDelayMs(attempt, options, retryAfterMs), signal);
				continue;
			}
			throw lastError;
		}
	}
	throw lastError ?? new Error("OpenAI compaction trigger failed");
}
