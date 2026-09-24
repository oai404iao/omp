import { WEBSOCKET_CONNECT_TIMEOUT_MS } from "./constants.js";
import type { ProviderEnv } from "@earendil-works/pi-ai";
import { WebSocketHandshakeError, extractWebSocketCloseError, extractWebSocketError } from "./errors.js";
import { proxyForWebSocketUrl } from "./proxy.js";
import { dynamicImport } from "./runtime.js";
import { type NodeWebSocketModule, type WebSocketLike } from "@oai404iao/pi-codex-runtime/internal/providers/openai-codex/types";

let nodeWebSocketModulePromise: Promise<NodeWebSocketModule> | undefined;

async function loadNodeWebSocketModule(): Promise<NodeWebSocketModule> {
	if (!nodeWebSocketModulePromise) {
		nodeWebSocketModulePromise = dynamicImport("ws") as Promise<NodeWebSocketModule>;
	}
	return nodeWebSocketModulePromise;
}

function nodeWebSocketHeaders(headers: Headers): Record<string, string> {
	return Object.fromEntries(headers.entries());
}

function nodeWebSocketResponseHeaders(headers: unknown): Record<string, string> {
	if (!headers || typeof headers !== "object") return {};
	const result: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
		if (Array.isArray(value)) result[name] = value.join(", ");
		else if (typeof value === "string") result[name] = value;
		else if (value !== undefined) result[name] = String(value);
	}
	return result;
}

function handshakeMessage(status: number, statusText: string | undefined, body: string): string {
	const trimmedBody = body.trim();
	if (trimmedBody) {
		try {
			const parsed = JSON.parse(trimmedBody) as { error?: { message?: unknown }; message?: unknown };
			const message = typeof parsed.error?.message === "string"
				? parsed.error.message
				: typeof parsed.message === "string"
					? parsed.message
					: undefined;
			if (message?.trim()) return message.trim();
		} catch {
			return trimmedBody;
		}
	}
	return statusText?.trim() || "WebSocket upgrade failed";
}

export async function connectWebSocket(
	url: string,
	headers: Headers,
	signal: AbortSignal | undefined,
	timeoutMs = WEBSOCKET_CONNECT_TIMEOUT_MS,
	env?: ProviderEnv,
): Promise<WebSocketLike> {
	if (signal?.aborted) throw new Error("Request was aborted");
	const { WebSocket } = await loadNodeWebSocketModule();
	const proxy = proxyForWebSocketUrl(url, env);
	let agent: unknown;
	if (proxy) {
		const protocol = new URL(proxy).protocol.toLowerCase();
		if (protocol === "http:" || protocol === "https:") {
			const { HttpsProxyAgent } = await dynamicImport("https-proxy-agent") as typeof import("https-proxy-agent");
			agent = new HttpsProxyAgent(proxy);
		} else if (protocol === "socks:" || protocol === "socks4:" || protocol === "socks4a:" || protocol === "socks5:" || protocol === "socks5h:") {
			const { SocksProxyAgent } = await dynamicImport("socks-proxy-agent") as {
				SocksProxyAgent: new (proxy: string) => unknown;
			};
			agent = new SocksProxyAgent(proxy);
		} else {
			throw new Error(`Unsupported WebSocket proxy protocol: ${protocol}`);
		}
	}

	return new Promise((resolve, reject) => {
		let settled = false;
		let socket: InstanceType<NodeWebSocketModule["WebSocket"]>;
		let timeout: ReturnType<typeof setTimeout> | undefined;

		try {
			socket = new WebSocket(url, {
				headers: nodeWebSocketHeaders(headers),
				perMessageDeflate: true,
				...(agent ? { agent } : {}),
			});
		} catch (error) {
			reject(error instanceof Error ? error : new Error(String(error)));
			return;
		}

		const onOpen = () => {
			if (settled) return;
			settled = true;
			cleanup();
			// Keep an error listener installed while the socket sits idle in the
			// session cache. Request parsers add their own listener, but Node's ws
			// EventEmitter would otherwise treat an idle "error" as uncaught.
			socket.on("error", () => {});
			const messageListeners = new Map<(event: unknown) => void, (...args: any[]) => void>();
			const closeListeners = new Map<(event: unknown) => void, (...args: any[]) => void>();
			resolve({
				get readyState() {
					return socket.readyState;
				},
				get bufferedAmount() {
					return socket.bufferedAmount;
				},
				send(data, callback) {
					socket.send(data, callback);
				},
				close(code, reason) {
					socket.close(code, reason);
				},
				addEventListener(type, listener) {
					if (type === "message") {
						const wrapped = (data: unknown, isBinary: boolean) => listener({ data, isBinary });
						messageListeners.set(listener, wrapped);
						socket.on("message", wrapped);
						return;
					}
					if (type === "close") {
						const wrapped = (code: number, reason: Buffer) => listener({
							code,
							reason: reason.toString("utf8"),
						});
						closeListeners.set(listener, wrapped);
						socket.on("close", wrapped);
						return;
					}
					socket.on(type, listener as (...args: any[]) => void);
				},
				removeEventListener(type, listener) {
					if (type === "message") {
						const wrapped = messageListeners.get(listener);
						if (wrapped) socket.off("message", wrapped);
						messageListeners.delete(listener);
						return;
					}
					if (type === "close") {
						const wrapped = closeListeners.get(listener);
						if (wrapped) socket.off("close", wrapped);
						closeListeners.delete(listener);
						return;
					}
					socket.off(type, listener as (...args: any[]) => void);
				},
			});
		};
		const onError = (event: unknown) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(event instanceof Error ? event : extractWebSocketError(event));
		};
		const onClose = (code: number, reason: Buffer) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(extractWebSocketCloseError({ code, reason: reason.toString("utf8") }));
		};
		const onUnexpectedResponse = (
			_request: unknown,
			response: { statusCode?: number; statusMessage?: string; headers?: unknown; on(type: string, listener: (...args: any[]) => void): void },
		) => {
			if (settled) return;
			let body = "";
			response.on("data", (chunk: unknown) => {
				if (body.length >= 64 * 1024) return;
				body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
			});
			response.on("end", () => {
				if (settled) return;
				settled = true;
				cleanup();
				const status = response.statusCode ?? 500;
				reject(new WebSocketHandshakeError(
					status,
					handshakeMessage(status, response.statusMessage, body),
					nodeWebSocketResponseHeaders(response.headers),
					body || undefined,
				));
			});
		};
		const onAbort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			socket.on("error", () => {});
			socket.terminate?.();
			reject(new Error("Request was aborted"));
		};
		const onTimeout = () => {
			if (settled) return;
			settled = true;
			cleanup();
			socket.on("error", () => {});
			socket.terminate?.();
			reject(new Error(`OpenAI Responses WebSocket connection timed out after ${timeoutMs}ms`));
		};

		const cleanup = () => {
			if (timeout) clearTimeout(timeout);
			socket.off("open", onOpen);
			socket.off("error", onError);
			socket.off("close", onClose);
			socket.off("unexpected-response", onUnexpectedResponse);
			signal?.removeEventListener("abort", onAbort);
		};

		socket.on("open", onOpen);
		socket.on("error", onError);
		socket.on("close", onClose);
		socket.on("unexpected-response", onUnexpectedResponse);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (timeoutMs > 0) timeout = setTimeout(onTimeout, timeoutMs);
		if (signal?.aborted) onAbort();
	});
}
