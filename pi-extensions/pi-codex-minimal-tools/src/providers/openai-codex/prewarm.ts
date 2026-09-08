import { WEBSOCKET_CONNECT_TIMEOUT_MS, WEBSOCKET_SEND_TIMEOUT_MS } from "./constants.js";
import { prepareWebSocketRequestBodyForWire } from "./continuation.js";
import { mapCodexEvents } from "./events.js";
import { withWebSocketRequestMetadata } from "./request-metadata.js";
import { type ResponsesBody, type WebSocketPrewarmRequest } from "./types.js";
import { parseWebSocket, sendWebSocketRequest } from "./websocket-events.js";
import { acquireWebSocket } from "./websocket-session.js";

export async function prewarmWebSocket(request: WebSocketPrewarmRequest): Promise<void> {
	if ((request.body.input?.length ?? 0) > 0) {
		throw new Error("Startup WebSocket prewarm must not include conversation input");
	}
	const acquired = await acquireWebSocket(
		request.url,
		request.headers,
		request.cacheKey,
		request.requestMetadata.sessionId,
		request.signal,
		request.connectTimeoutMs ?? WEBSOCKET_CONNECT_TIMEOUT_MS,
	);
	const { socket, entry } = acquired;
	let keepConnection = true;
	let released = false;
	const releaseOnce = (options?: { keep?: boolean }) => {
		if (released) return;
		released = true;
		acquired.release(options);
	};

	try {
		const fullBody = withWebSocketRequestMetadata(request.body, request.requestMetadata);
		const prewarmBody: ResponsesBody = {
			...fullBody,
			generate: false,
		};
		// A startup prewarm is the root of a new session continuation. Never
		// chain another generate:false request from an existing response.
		if (entry?.continuation) entry.continuation = undefined;
		const requestBody = prewarmBody;
		const wireBody = prepareWebSocketRequestBodyForWire(requestBody);
		if (request.signal?.aborted) throw new Error("Request was aborted");
		await sendWebSocketRequest(
			socket,
			JSON.stringify({ type: "response.create", ...wireBody }),
			request.signal,
			WEBSOCKET_SEND_TIMEOUT_MS,
		);
		const responseItems: unknown[] = [];
		let responseId: string | undefined;
		for await (const event of mapCodexEvents(parseWebSocket(socket, request.signal), request.requestMetadata.sessionId)) {
			if (event.type === "response.created" && event.response?.id) responseId = event.response.id;
			if (event.type === "response.output_item.done" && event.item) responseItems.push(event.item);
			if (
				(event.type === "response.completed" || event.type === "response.incomplete")
				&& event.response?.id
			) {
				responseId = event.response.id;
			}
		}
		if (entry && responseId) {
			entry.continuation = {
				lastRequestBody: prewarmBody,
				lastResponseId: responseId,
				lastResponseItems: responseItems,
			};
		}
		releaseOnce({ keep: true });
	} catch (error) {
		keepConnection = false;
		if (entry) entry.continuation = undefined;
		releaseOnce({ keep: false });
		throw error;
	} finally {
		releaseOnce({ keep: keepConnection });
	}
}
