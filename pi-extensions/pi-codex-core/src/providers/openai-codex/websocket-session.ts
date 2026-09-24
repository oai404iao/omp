import { SESSION_WEBSOCKET_CACHE_TTL_MS } from "./constants.js";
import type { ProviderEnv } from "@earendil-works/pi-ai";
import { type AcquiredWebSocket, type SessionWebSocketCacheEntry, type WebSocketAcquireWaiter } from "@oai404iao/pi-codex-runtime/internal/providers/openai-codex/types";
import { connectWebSocket } from "./websocket-connection.js";
import { closeWebSocketSilently, isWebSocketReusable } from "./websocket-socket.js";

export const websocketSessionCache = new Map<string, SessionWebSocketCacheEntry>();

const websocketConnectionPromises = new Map<string, {
	promise: Promise<SessionWebSocketCacheEntry>;
	abort: AbortController;
}>();

export const websocketHttpFallbackSessions = new Set<string>();

export function closeProviderWebSocketSessions(sessionId?: string): void {
	for (const [cacheKey, pending] of websocketConnectionPromises) {
		if (sessionId && !cacheKey.startsWith(`${sessionId}\n`)) continue;
		pending.abort.abort();
		websocketConnectionPromises.delete(cacheKey);
	}
	for (const [cacheKey, entry] of websocketSessionCache) {
		if (sessionId && !cacheKey.startsWith(`${sessionId}\n`)) continue;
		if (entry.idleTimer) clearTimeout(entry.idleTimer);
		for (const waiter of entry.waiters.splice(0)) {
			if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
			waiter.reject(new Error("WebSocket session closed"));
		}
		closeWebSocketSilently(entry.socket, 1000, "session_shutdown");
		websocketSessionCache.delete(cacheKey);
	}
	if (sessionId) {
		for (const fallbackKey of websocketHttpFallbackSessions) {
			if (fallbackKey.startsWith(`${sessionId}\n`)) websocketHttpFallbackSessions.delete(fallbackKey);
		}
	} else {
		websocketHttpFallbackSessions.clear();
	}
}

function scheduleSessionWebSocketExpiry(cacheKey: string, entry: SessionWebSocketCacheEntry): void {
	if (entry.idleTimer) {
		clearTimeout(entry.idleTimer);
	}
	entry.idleTimer = setTimeout(() => {
		if (entry.busy || entry.waiters.length > 0) return;
		closeWebSocketSilently(entry.socket, 1000, "idle_timeout");
		websocketSessionCache.delete(cacheKey);
	}, SESSION_WEBSOCKET_CACHE_TTL_MS);
}

function removeWebSocketWaiter(entry: SessionWebSocketCacheEntry, waiter: WebSocketAcquireWaiter): void {
	const index = entry.waiters.indexOf(waiter);
	if (index >= 0) entry.waiters.splice(index, 1);
	if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
}

function acquireCachedWebSocketEntry(
	cacheKey: string,
	entry: SessionWebSocketCacheEntry,
	reused: boolean,
): AcquiredWebSocket {
	entry.busy = true;
	let released = false;
	const release = ({ keep } = {} as { keep?: boolean }) => {
		if (released) return;
		const reusable = keep !== false && isWebSocketReusable(entry.socket);
		if (!reusable) {
			released = true;
			if (entry.idleTimer) clearTimeout(entry.idleTimer);
			closeWebSocketSilently(entry.socket);
			if (websocketSessionCache.get(cacheKey) === entry) {
				websocketSessionCache.delete(cacheKey);
			}
			for (const waiter of entry.waiters.splice(0)) {
				if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
				waiter.reject(new Error("WebSocket connection became unavailable"));
			}
			return;
		}

		while (entry.waiters.length > 0) {
			const waiter = entry.waiters.shift()!;
			if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
			if (waiter.signal?.aborted) {
				waiter.reject(new Error("Request was aborted"));
				continue;
			}
			released = true;
			waiter.resolve(acquireCachedWebSocketEntry(cacheKey, entry, true));
			return;
		}

		entry.busy = false;
		released = true;
		scheduleSessionWebSocketExpiry(cacheKey, entry);
	};
	return {
		socket: entry.socket,
		entry,
		reused,
		release,
	};
}

async function waitForCachedWebSocket(
	cacheKey: string,
	entry: SessionWebSocketCacheEntry,
	signal: AbortSignal | undefined,
): Promise<AcquiredWebSocket> {
	if (signal?.aborted) throw new Error("Request was aborted");
	return new Promise<AcquiredWebSocket>((resolve, reject) => {
		const waiter: WebSocketAcquireWaiter = {
			resolve,
			reject,
			...(signal ? { signal } : {}),
		};
		if (signal) {
			waiter.onAbort = () => {
				removeWebSocketWaiter(entry, waiter);
				reject(new Error("Request was aborted"));
			};
			signal.addEventListener("abort", waiter.onAbort, { once: true });
		}
		entry.waiters.push(waiter);
	});
}

function waitForConnection(
	connection: Promise<SessionWebSocketCacheEntry>,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<SessionWebSocketCacheEntry> {
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		const onAbort = () => { cleanup(); reject(new Error("Request was aborted")); };
		const timer = timeoutMs > 0 ? setTimeout(() => {
			cleanup();
			reject(new Error(`OpenAI Responses WebSocket connection timed out after ${timeoutMs}ms`));
		}, timeoutMs) : undefined;
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
		// A joining caller owns only its wait, not the shared handshake.
		connection.then(
			(entry) => { cleanup(); resolve(entry); },
			(error) => { cleanup(); reject(error); },
		);
	});
}

export async function acquireWebSocket(
	url: string,
	headers: Headers,
	cacheKey: string | undefined,
	sessionId: string | undefined,
	signal: AbortSignal | undefined,
	connectTimeoutMs: number,
	env?: ProviderEnv,
): Promise<AcquiredWebSocket> {
	if (signal?.aborted) throw new Error("Request was aborted");
	if (!cacheKey || !sessionId) {
		const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, env);
		return {
			socket,
			reused: false,
			release: ({ keep } = {}) => {
				if (keep === false) {
					closeWebSocketSilently(socket);
					return;
				}
				closeWebSocketSilently(socket);
			},
		};
	}

	const cached = websocketSessionCache.get(cacheKey);
	if (cached) {
		if (cached.idleTimer) {
			clearTimeout(cached.idleTimer);
			cached.idleTimer = undefined;
		}

		if (!cached.busy && isWebSocketReusable(cached.socket)) {
			return acquireCachedWebSocketEntry(cacheKey, cached, true);
		}

		if (cached.busy) {
			return waitForCachedWebSocket(cacheKey, cached, signal);
		}

		if (!isWebSocketReusable(cached.socket)) {
			closeWebSocketSilently(cached.socket);
			websocketSessionCache.delete(cacheKey);
		}
	}

	let pendingConnection = websocketConnectionPromises.get(cacheKey);
	const joiningConnection = pendingConnection !== undefined;
	if (!pendingConnection) {
		const abort = new AbortController();
		const connectionSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
		let connectionPromise!: Promise<SessionWebSocketCacheEntry>;
		connectionPromise = connectWebSocket(url, headers, connectionSignal, connectTimeoutMs, env)
			.then((socket) => {
				if (websocketConnectionPromises.get(cacheKey)?.promise !== connectionPromise) {
					closeWebSocketSilently(socket, 1000, "session_shutdown");
					throw new Error("WebSocket session closed");
				}
				const entry: SessionWebSocketCacheEntry = { socket, busy: false, waiters: [] };
				websocketSessionCache.set(cacheKey, entry);
				return entry;
			})
			.finally(() => {
				if (websocketConnectionPromises.get(cacheKey)?.promise === connectionPromise) {
					websocketConnectionPromises.delete(cacheKey);
				}
			});
		pendingConnection = { promise: connectionPromise, abort };
		websocketConnectionPromises.set(cacheKey, pendingConnection);
	}
	const entry = joiningConnection
		? await waitForConnection(pendingConnection.promise, signal, connectTimeoutMs)
		: await pendingConnection.promise;
	if (entry.busy) return waitForCachedWebSocket(cacheKey, entry, signal);
	return acquireCachedWebSocketEntry(cacheKey, entry, false);
}
