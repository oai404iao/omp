import { type Api, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { resolveCodexRequestProfile } from "@oai404iao/pi-codex-runtime/internal/codex-request-profile";
import { type CodexRequestIdentity } from "@oai404iao/pi-codex-runtime/internal/codex-wire-identity";
import { type ResolvedCodexModelSettings } from "@oai404iao/pi-codex-runtime/internal/model-catalog/runtime";
import { webSocketFallbackKey } from "../../providers/openai-codex/cache-key.js";
import { CODEX_REMOTE_COMPACTION_STREAM_RETRIES } from "../../providers/openai-codex/constants.js";
import { withResponsesLiteWebSocketMetadata } from "../../providers/openai-codex/lite.js";
import { createPiTurnId, withSseRequestMetadata } from "../../providers/openai-codex/request-metadata.js";
import { isRetryableWebSocketError, isWebSocketConnectionLimitReachedError, isWebSocketUpgradeRejectedError, sleep, webSocketCompactionRetryDelayMs, webSocketStreamMaxRetries } from "../../providers/openai-codex/retry.js";
import { type ResponsesBody, type WebSocketRequestMetadata } from "@oai404iao/pi-codex-runtime/internal/providers/openai-codex/types";
import { resolveCodexUrl, resolveResponsesWebSocketUrl } from "../../providers/openai-codex/urls.js";
import { websocketHttpFallbackSessions } from "../../providers/openai-codex/websocket-session.js";
import { requestCodexCompactionTrigger } from "./http.js";
import { requestCodexCompactionTriggerWebSocket } from "./websocket.js";

export async function requestCodexCompactionTriggerWithTransport(
	model: Model<Api>,
	headers: {
		sse: Headers;
		websocket: Headers;
	},
	body: ResponsesBody,
	options: {
		sessionId?: string;
		turnId?: string;
		requestIdentity?: CodexRequestIdentity;
		signal?: AbortSignal;
		settings: ResolvedCodexModelSettings;
		maxRetries?: number;
		maxRetryDelayMs?: number;
	},
): Promise<unknown> {
	const transport = options.settings.openaiTransport;
	const responsesMode = resolveCodexRequestProfile(options.settings.requestProfile).responsesMode;
	const sseUrl = resolveCodexUrl(model.baseUrl, { apiKeyMode: options.settings.apiKeyMode });
	const requestMetadata: WebSocketRequestMetadata = {
		...(options.sessionId ? { sessionId: options.sessionId } : {}),
		...(options.requestIdentity?.threadId
			? { threadId: options.requestIdentity.threadId }
			: {}),
		turnId: options.requestIdentity?.turnId
			|| options.turnId
			|| createPiTurnId(),
		requestKind: "compaction",
		...(options.requestIdentity
			? { identity: options.requestIdentity }
			: {}),
	};
	if (transport === "sse") {
		return requestCodexCompactionTrigger(
			sseUrl,
			headers.sse,
			withSseRequestMetadata(body, requestMetadata),
			options.signal,
			options.sessionId,
		);
	}

	const websocketUrl = resolveResponsesWebSocketUrl(model.baseUrl, { apiKeyMode: options.settings.apiKeyMode });
	const fallbackKey = webSocketFallbackKey(
		options.sessionId,
		model,
		websocketUrl,
		options.settings.modelProfileHash,
	);
	if (
		transport === "auto"
		&& fallbackKey
		&& websocketHttpFallbackSessions.has(fallbackKey)
	) {
		return requestCodexCompactionTrigger(
			sseUrl,
			headers.sse,
			withSseRequestMetadata(body, requestMetadata),
			options.signal,
			options.sessionId,
		);
	}

	const maxRetries = Math.min(
		CODEX_REMOTE_COMPACTION_STREAM_RETRIES,
		webSocketStreamMaxRetries({
			maxRetries: options.maxRetries,
		} as SimpleStreamOptions),
	);
	const retryOptions = {
		...(options.maxRetryDelayMs !== undefined ? { maxRetryDelayMs: options.maxRetryDelayMs } : {}),
	} as SimpleStreamOptions;
	let retries = 0;
	while (true) {
		try {
			return await requestCodexCompactionTriggerWebSocket(
				websocketUrl,
				headers.websocket,
				withResponsesLiteWebSocketMetadata(body, responsesMode),
				model,
				requestMetadata,
				options.signal,
				options.settings.modelProfileHash,
			);
		} catch (error) {
			if (options.signal?.aborted) throw new Error("Request was aborted");
			const upgradeRejected = isWebSocketUpgradeRejectedError(error);
			if (transport === "auto" && upgradeRejected) {
				if (fallbackKey) websocketHttpFallbackSessions.add(fallbackKey);
				break;
			}
			const retryable = isWebSocketConnectionLimitReachedError(error) || isRetryableWebSocketError(error);
			if (retryable && retries < maxRetries) {
				retries++;
				await sleep(webSocketCompactionRetryDelayMs(error, retries, retryOptions), options.signal);
				continue;
			}
			throw error;
		}
	}

	return requestCodexCompactionTrigger(
		sseUrl,
		headers.sse,
		withSseRequestMetadata(body, requestMetadata),
		options.signal,
		options.sessionId,
	);
}
