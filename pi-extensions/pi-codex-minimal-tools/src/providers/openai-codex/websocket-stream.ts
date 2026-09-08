import { type Api, type AssistantMessage, type AssistantMessageEventStream, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { type SavedGeneratedImage } from "../../tools/image-generation/types.js";
import { type CitationSource, type WebSearchCitationSource } from "../responses/types.js";
import { webSocketCacheKey } from "./cache-key.js";
import { processCapturedResponsesStream } from "./captured-stream.js";
import { WEBSOCKET_CONNECT_TIMEOUT_MS, WEBSOCKET_SEND_TIMEOUT_MS } from "./constants.js";
import { buildCachedWebSocketRequestBody, prepareWebSocketRequestBodyForWire } from "./continuation.js";
import { withWebSocketRequestMetadata } from "./request-metadata.js";
import { isPreviousResponseNotFoundError, isRetryableEarlyWebSocketError } from "./retry.js";
import { type ResponsesBody, type WebSocketRequestMetadata } from "./types.js";
import { countWebSocketEvents, parseWebSocket, sendWebSocketRequest, startWebSocketOutputOnFirstEvent } from "./websocket-events.js";
import { acquireWebSocket } from "./websocket-session.js";

export async function processWebSocketStream<TApi extends Api>(
	url: string,
	body: ResponsesBody,
	headers: Headers,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<TApi>,
	onStart: () => void,
	options: SimpleStreamOptions | undefined,
	deps: {
		onImageSaved?: (savedImage: SavedGeneratedImage, imageData: { data: string; mimeType: string }) => void;
	},
	cwd: string,
	requestPrompt: string | undefined,
	webSearchCitationSources: ReadonlyArray<WebSearchCitationSource>,
	historicalCitationSources: ReadonlyArray<CitationSource>,
	requestMetadata: WebSocketRequestMetadata,
	profileHash?: string,
	startupPrewarm?: Promise<void>,
): Promise<void> {
	let streamStarted = false;
	let disableCachedContext = false;
	let staleSocketRetried = false;
	let missingPreviousResponseRetried = false;

	while (true) {
		if (startupPrewarm) {
			await startupPrewarm;
			startupPrewarm = undefined;
		}
		const cacheKey = webSocketCacheKey(
			options?.sessionId,
			model as Model<Api>,
			url,
			headers,
			profileHash,
		);
		const { socket, entry, release, reused } = await acquireWebSocket(
			url,
			headers,
			cacheKey,
			options?.sessionId,
			options?.signal,
			WEBSOCKET_CONNECT_TIMEOUT_MS,
		);
		let keepConnection = true;
		let released = false;
		let eventCount = 0;
		// Continuation is safe only when buildCachedWebSocketRequestBody proves
		// that this request exactly extends the cached logical request.
		const useCachedContext = true;
		// ChatGPT Codex Responses rejects `store: true` ("Store must be set to false").
		// WebSocket continuation still works via connection-scoped previous_response_id state.
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
				options?.signal,
				WEBSOCKET_SEND_TIMEOUT_MS,
			);
			const startOutput = () => {
				if (streamStarted) return;
				onStart();
				stream.push({ type: "start", partial: output });
				streamStarted = true;
			};
			const continuationResult = await processCapturedResponsesStream(
				startWebSocketOutputOnFirstEvent(
					countWebSocketEvents(parseWebSocket(socket, options?.signal), () => {
						eventCount++;
					}),
					startOutput,
				),
				output,
				stream,
				model,
				options,
				options?.sessionId,
				deps,
				cwd,
				requestPrompt,
				webSearchCitationSources,
				historicalCitationSources,
			);
			if (options?.signal?.aborted) {
				keepConnection = false;
			} else if (entry && continuationResult.responseId) {
				entry.continuation = {
					lastRequestBody: fullBody,
					lastResponseId: continuationResult.responseId,
					lastResponseItems: continuationResult.responseItems,
				};
			} else if (entry) {
				entry.continuation = undefined;
			}
			releaseOnce({ keep: keepConnection });
			return;
		} catch (error) {
			if (entry) {
				entry.continuation = undefined;
			}
			keepConnection = false;
			releaseOnce({ keep: false });
			// Pi's stock provider reuses session WebSockets. In practice the Codex
			// backend sometimes cleanly closes an idle cached socket between turns;
			// if that stale socket fails before any response event, retry once on a
			// fresh WebSocket without changing request shape or falling back transports.
			if (!staleSocketRetried && reused && eventCount === 0 && !options?.signal?.aborted && isRetryableEarlyWebSocketError(error)) {
				staleSocketRetried = true;
				continue;
			}
			if (
				!missingPreviousResponseRetried
				&& requestBody.previous_response_id
				&& !streamStarted
				&& !options?.signal?.aborted
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
