import { WEBSOCKET_EVENT_QUEUE_CAPACITY, WEBSOCKET_IDLE_TIMEOUT_MS, WEBSOCKET_SEND_TIMEOUT_MS } from "./constants.js";
import { NonRetryableProviderError, ProviderProtocolError, extractWebSocketCloseError, extractWebSocketError } from "./errors.js";
import { type StreamEventShape, type WebSocketLike } from "@oai404iao/pi-codex-runtime/internal/providers/openai-codex/types";

export class WebSocketMessageTooLargeError extends NonRetryableProviderError {
	constructor(readonly beforeResponseText: boolean) {
		super(beforeResponseText
			? "OpenAI Responses WebSocket request exceeds the peer's message size limit (close code 1009)"
			: "OpenAI Responses WebSocket message size limit reached after response text arrived (close code 1009)");
		this.name = "WebSocketMessageTooLargeError";
	}
}

const CLOSE_AFTER_TRANSPORT_FAILURE_TIMEOUT_MS = 250;

export async function* streamWebSocketRequest(
	socket: WebSocketLike,
	payload: string,
	signal: AbortSignal | undefined,
	idleTimeoutMs = WEBSOCKET_IDLE_TIMEOUT_MS,
	sendTimeoutMs = WEBSOCKET_SEND_TIMEOUT_MS,
): AsyncIterable<StreamEventShape> {
	if (signal?.aborted) throw new Error("Request was aborted");
	const queue: StreamEventShape[] = [];
	let pending: (() => void) | null = null;
	let done = false;
	let sending = true;
	let transportFailure: Error | undefined;
	let closeWaitTimer: ReturnType<typeof setTimeout> | undefined;
	let failed: Error | null = null;
	let closeError: Error | undefined;
	let sawResponseText = false;
	let sawCompletion = false;
	let pendingMessages = 0;
	let messageChain = Promise.resolve();

	const wake = () => {
		if (!pending) return;
		const resolve = pending;
		pending = null;
		resolve();
	};

	const finish = () => {
		done = true;
		wake();
	};

	const waitForCloseAfterFailure = (error: Error) => {
		if (done || transportFailure) return;
		transportFailure = error;
		// A transport failure can surface before the peer's close code is delivered.
		if (socket.readyState === 3) finish();
		else {
			const waitMs = !sending && idleTimeoutMs > 0
				? Math.min(idleTimeoutMs, CLOSE_AFTER_TRANSPORT_FAILURE_TIMEOUT_MS)
				: CLOSE_AFTER_TRANSPORT_FAILURE_TIMEOUT_MS;
			closeWaitTimer = setTimeout(finish, waitMs);
			wake();
		}
	};

	const onMessage = (event: unknown) => {
		if (done || !event || typeof event !== "object" || !("data" in event)) return;
		const { data, isBinary } = event as { data: unknown; isBinary?: unknown };
		// A close can arrive before queued parsing runs; malformed text still counts.
		if (isBinary !== true) sawResponseText = true;
		if (queue.length + pendingMessages >= WEBSOCKET_EVENT_QUEUE_CAPACITY) {
			failed = new ProviderProtocolError(
				`OpenAI Responses WebSocket event queue exceeded ${WEBSOCKET_EVENT_QUEUE_CAPACITY} items`,
			);
			done = true;
			wake();
			return;
		}
		pendingMessages++;
		messageChain = messageChain
			.then(async () => {
				if (isBinary === true) {
					failed = new ProviderProtocolError("Unexpected binary OpenAI Responses WebSocket event");
					done = true;
					return;
				}
				const text = typeof data === "string"
					? data
					: Buffer.isBuffer(data)
						? data.toString("utf8")
						: ArrayBuffer.isView(data)
							? Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8")
							: null;
				if (text === null) {
					failed = new ProviderProtocolError("Unsupported OpenAI Responses WebSocket message payload");
					done = true;
					return;
				}
				try {
					const parsed = JSON.parse(text) as StreamEventShape;
					const type = typeof parsed.type === "string" ? parsed.type : "";
					if (type === "response.completed" || type === "response.done" || type === "response.incomplete") {
						sawCompletion = true;
						closeError = undefined;
						done = true;
					}
					if (queue.length >= WEBSOCKET_EVENT_QUEUE_CAPACITY) {
						failed = new ProviderProtocolError(
							`OpenAI Responses WebSocket event queue exceeded ${WEBSOCKET_EVENT_QUEUE_CAPACITY} items`,
						);
						done = true;
						return;
					}
					queue.push(parsed);
				} catch {
					// Match Codex: malformed text frames are logged/ignored rather than
					// tearing down an otherwise healthy response stream.
				}
			})
			.catch((error: unknown) => {
				failed = error instanceof Error ? error : new Error(String(error));
				done = true;
			})
			.finally(() => {
				pendingMessages--;
				wake();
			});
	};

	const onError = (event: unknown) => {
		const error = extractWebSocketError(event);
		const code = (event as { code?: unknown } | null | undefined)?.code;
		// `ws` receiver/protocol errors are local, not a peer rejection of our request.
		if (typeof code === "string" && code.startsWith("WS_ERR_")) {
			failed = error;
			finish();
		} else {
			waitForCloseAfterFailure(error);
		}
	};

	const onClose = (event: unknown) => {
		if (sawCompletion) {
			finish();
			return;
		}
		if (!closeError) {
			const code = (event as { code?: unknown } | null | undefined)?.code;
			closeError = code === 1009
				? new WebSocketMessageTooLargeError(!sawResponseText)
				: extractWebSocketCloseError(event);
		}
		finish();
	};

	socket.addEventListener("message", onMessage);
	socket.addEventListener("error", onError);
	socket.addEventListener("close", onClose);
	signal?.addEventListener("abort", finish);

	const sendTimer = setTimeout(() => {
		if (done) return;
		transportFailure ??= new Error(`OpenAI Responses WebSocket send timed out after ${sendTimeoutMs}ms`);
		finish();
	}, Math.max(1, sendTimeoutMs));
	try {
		try {
			socket.send(payload, (error?: Error) => {
				if (done || transportFailure) return;
				if (error) {
					waitForCloseAfterFailure(new Error(`Failed to send OpenAI Responses WebSocket request: ${error.message}`));
				} else {
					sending = false;
					clearTimeout(sendTimer);
					wake();
				}
			});
		} catch (error) {
			waitForCloseAfterFailure(error instanceof Error ? error : new Error(String(error)));
		}

		while (true) {
			if (signal?.aborted) {
				throw new Error("Request was aborted");
			}
			if (queue.length > 0 && (!sending || done)) {
				yield queue.shift() as StreamEventShape;
				continue;
			}
			if (done && pendingMessages === 0) break;
			await new Promise<void>((resolve, reject) => {
				const timeout = !sending && !transportFailure && idleTimeoutMs > 0 ? setTimeout(() => {
					pending = null;
					reject(new Error(`OpenAI Responses WebSocket idle timeout after ${idleTimeoutMs}ms`));
				}, idleTimeoutMs) : undefined;
				pending = () => {
					clearTimeout(timeout);
					resolve();
				};
			});
		}

		if (failed) throw failed;
		if (closeError instanceof WebSocketMessageTooLargeError) throw closeError;
		if (transportFailure && !sawCompletion) {
			if (sending && sawResponseText) {
				throw new NonRetryableProviderError("OpenAI Responses WebSocket send failed after response text arrived", { cause: transportFailure });
			}
			throw transportFailure;
		}
		if (closeError && !sawCompletion) throw closeError;
		if (!sawCompletion) {
			throw new Error("WebSocket stream closed before response.completed");
		}
	} finally {
		clearTimeout(sendTimer);
		clearTimeout(closeWaitTimer);
		socket.removeEventListener("message", onMessage);
		socket.removeEventListener("error", onError);
		socket.removeEventListener("close", onClose);
		signal?.removeEventListener("abort", finish);
	}
}

export async function* startWebSocketOutputOnFirstEvent(
	events: AsyncIterable<StreamEventShape>,
	onStart: () => void,
): AsyncIterable<StreamEventShape> {
	let started = false;
	for await (const event of events) {
		if (!started && event.type !== "error" && event.type !== "response.failed") {
			started = true;
			onStart();
		}
		yield event;
	}
}

export async function* countWebSocketEvents(
	events: AsyncIterable<StreamEventShape>,
	onEvent: () => void,
): AsyncIterable<StreamEventShape> {
	for await (const event of events) {
		onEvent();
		yield event;
	}
}
