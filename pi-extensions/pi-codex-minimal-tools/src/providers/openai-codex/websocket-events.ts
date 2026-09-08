import { WEBSOCKET_EVENT_QUEUE_CAPACITY, WEBSOCKET_IDLE_TIMEOUT_MS, WEBSOCKET_SEND_TIMEOUT_MS } from "./constants.js";
import { ProviderProtocolError, extractWebSocketCloseError, extractWebSocketError } from "./errors.js";
import { type StreamEventShape, type WebSocketLike } from "./types.js";

export async function sendWebSocketRequest(
	socket: WebSocketLike,
	payload: string,
	signal: AbortSignal | undefined,
	timeoutMs = WEBSOCKET_SEND_TIMEOUT_MS,
): Promise<void> {
	if (signal?.aborted) throw new Error("Request was aborted");
	await new Promise<void>((resolve, reject) => {
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			if (error) reject(error);
			else resolve();
		};
		const onAbort = () => finish(new Error("Request was aborted"));
		timeout = setTimeout(
			() => finish(new Error(`OpenAI Responses WebSocket send timed out after ${timeoutMs}ms`)),
			Math.max(1, timeoutMs),
		);
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			socket.send(payload, (error?: Error) => {
				if (error) {
					finish(new Error(`Failed to send OpenAI Responses WebSocket request: ${error.message}`));
					return;
				}
				finish();
			});
		} catch (error) {
			finish(error instanceof Error ? error : new Error(String(error)));
		}
	});
}

export async function* parseWebSocket(socket: WebSocketLike, signal: AbortSignal | undefined): AsyncIterable<StreamEventShape> {
	const queue: StreamEventShape[] = [];
	let pending: (() => void) | null = null;
	let done = false;
	let failed: Error | null = null;
	let closeError: Error | null = null;
	let sawCompletion = false;
	let pendingMessages = 0;
	let messageChain = Promise.resolve();

	const wake = () => {
		if (!pending) return;
		const resolve = pending;
		pending = null;
		resolve();
	};

	const onMessage = (event: unknown) => {
		if (done) return;
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
				if (!event || typeof event !== "object" || !("data" in event)) return;
				if ((event as { isBinary?: unknown }).isBinary === true) {
					failed = new ProviderProtocolError("Unexpected binary OpenAI Responses WebSocket event");
					done = true;
					return;
				}
				const data = (event as { data?: unknown }).data;
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
						closeError = null;
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
		failed = extractWebSocketError(event);
		done = true;
		wake();
	};

	const onClose = (event: unknown) => {
		if (sawCompletion) {
			done = true;
			wake();
			return;
		}
		if (!closeError) {
			closeError = extractWebSocketCloseError(event);
		}
		done = true;
		wake();
	};

	const onAbort = () => {
		failed = new Error("Request was aborted");
		done = true;
		wake();
	};

	socket.addEventListener("message", onMessage);
	socket.addEventListener("error", onError);
	socket.addEventListener("close", onClose);
	signal?.addEventListener("abort", onAbort);

	try {
		while (true) {
			if (signal?.aborted) {
				throw new Error("Request was aborted");
			}
			if (queue.length > 0) {
				yield queue.shift() as StreamEventShape;
				continue;
			}
			if (done && pendingMessages === 0) break;
			await new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(() => {
					pending = null;
					reject(new Error(`OpenAI Responses WebSocket idle timeout after ${WEBSOCKET_IDLE_TIMEOUT_MS}ms`));
				}, WEBSOCKET_IDLE_TIMEOUT_MS);
				pending = () => {
					clearTimeout(timeout);
					resolve();
				};
			});
		}

		if (failed) throw failed;
		if (closeError && !sawCompletion) throw closeError;
		if (!sawCompletion) {
			throw new Error("WebSocket stream closed before response.completed");
		}
	} finally {
		socket.removeEventListener("message", onMessage);
		socket.removeEventListener("error", onError);
		socket.removeEventListener("close", onClose);
		signal?.removeEventListener("abort", onAbort);
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
