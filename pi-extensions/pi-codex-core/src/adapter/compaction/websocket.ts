import { type Api, type Model } from "@earendil-works/pi-ai/compat";
import { webSocketCacheKey } from "../../providers/openai-codex/cache-key.js";
import { WEBSOCKET_CONNECT_TIMEOUT_MS, WEBSOCKET_SEND_TIMEOUT_MS } from "../../providers/openai-codex/constants.js";
import { buildCachedWebSocketRequestBody, prepareWebSocketRequestBodyForWire } from "../../providers/openai-codex/continuation.js";
import { mapCodexEvents } from "../../providers/openai-codex/events.js";
import { withWebSocketRequestMetadata } from "../../providers/openai-codex/request-metadata.js";
import { isPreviousResponseNotFoundError, isRetryableEarlyWebSocketError } from "../../providers/openai-codex/retry.js";
import { type ResponsesBody, type WebSocketRequestMetadata } from "@oai404iao/pi-codex-runtime/internal/providers/openai-codex/types";
import { countWebSocketEvents, parseWebSocket, sendWebSocketRequest } from "../../providers/openai-codex/websocket-events.js";
import { acquireWebSocket } from "../../providers/openai-codex/websocket-session.js";
import { collectCodexCompactionStream } from "./collect.js";

export async function requestCodexCompactionTriggerWebSocket(
	url: string,
	headers: Headers,
	body: ResponsesBody,
	model: Model<Api>,
	requestMetadata: WebSocketRequestMetadata,
	signal: AbortSignal | undefined,
	profileHash?: string,
): Promise<unknown> {
	let disableCachedContext = false;
	let staleSocketRetried = false;
	let missingPreviousResponseRetried = false;

	while (true) {
		const cacheKey = webSocketCacheKey(
			requestMetadata.sessionId,
			model,
			url,
			headers,
			profileHash,
		);
		const { socket, entry, release, reused } = await acquireWebSocket(
			url,
			headers,
			cacheKey,
			requestMetadata.sessionId,
			signal,
			WEBSOCKET_CONNECT_TIMEOUT_MS,
		);
		let keepConnection = true;
		let released = false;
		let eventCount = 0;
		// All reusable WebSocket transports opportunistically continue an exact
		// logical request prefix. `websocket` still sends a full request whenever
		// the stable fields or input prefix do not match.
		const useCachedContext = true;
		const fullBody = withWebSocketRequestMetadata(body, requestMetadata);
		const requestBody = useCachedContext && !disableCachedContext && entry
			? buildCachedWebSocketRequestBody(entry, fullBody)
			: fullBody;
		const wireRequestBody = prepareWebSocketRequestBodyForWire(requestBody);
		const releaseOnce = (releaseOptions?: { keep?: boolean }) => {
			if (released) return;
			released = true;
			release(releaseOptions);
		};

		try {
			await sendWebSocketRequest(
				socket,
				JSON.stringify({ type: "response.create", ...wireRequestBody }),
				signal,
				WEBSOCKET_SEND_TIMEOUT_MS,
			);
			const result = await collectCodexCompactionStream(
				mapCodexEvents(
					countWebSocketEvents(parseWebSocket(socket, signal), () => {
						eventCount++;
					}),
					requestMetadata.sessionId,
				),
			);
			if (signal?.aborted) {
				keepConnection = false;
				throw new Error("Request was aborted");
			}
			if (entry && result.responseId) {
				entry.continuation = {
					lastRequestBody: fullBody,
					lastResponseId: result.responseId,
					lastResponseItems: result.responseItems,
				};
			} else if (entry) {
				entry.continuation = undefined;
			}
			releaseOnce({ keep: true });
			return result.item;
		} catch (error) {
			if (entry) entry.continuation = undefined;
			keepConnection = false;
			releaseOnce({ keep: false });
			if (
				!staleSocketRetried
				&& reused
				&& eventCount === 0
				&& !signal?.aborted
				&& isRetryableEarlyWebSocketError(error)
			) {
				staleSocketRetried = true;
				continue;
			}
			if (
				!missingPreviousResponseRetried
				&& requestBody.previous_response_id
				&& !signal?.aborted
				&& isPreviousResponseNotFoundError(error)
			) {
				missingPreviousResponseRetried = true;
				disableCachedContext = true;
				continue;
			}
			throw error;
		} finally {
			releaseOnce({ keep: keepConnection });
		}
	}
}
