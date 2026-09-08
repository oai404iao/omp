import { SESSION_WEBSOCKET_CACHE_TTL_MS } from "./constants.js";
import { type AcquiredWebSocket, type SessionWebSocketCacheEntry, type WebSocketAcquireWaiter } from "./types.js";
import { connectWebSocket } from "./websocket-connection.js";
import { closeWebSocketSilently, isWebSocketReusable } from "./websocket-socket.js";

export const websocketSessionCache = new Map<string, SessionWebSocketCacheEntry>();

const websocketConnectionPromises = new Map<string, Promise<SessionWebSocketCacheEntry>>();

export const websocketHttpFallbackSessions = new Set<string>();

export function closeProviderWebSocketSessions(sessionId?: string): void {
	for (const cacheKey of websocketConnectionPromises.keys()) {
		if (sessionId && !cacheKey.startsWith(`${sessionId}\n`)) continue;
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

export async function acquireWebSocket(
	url: string,
	headers: Headers,
	cacheKey: string | undefined,
	sessionId: string | undefined,
	signal: AbortSignal | undefined,
	connectTimeoutMs: number,
): Promise<AcquiredWebSocket> {
	if (!cacheKey || !sessionId) {
		const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs);
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
	if (!pendingConnection) {
		let connectionPromise!: Promise<SessionWebSocketCacheEntry>;
		connectionPromise = connectWebSocket(url, headers, signal, connectTimeoutMs)
			.then((socket) => {
				if (websocketConnectionPromises.get(cacheKey) !== connectionPromise) {
					closeWebSocketSilently(socket, 1000, "session_shutdown");
					throw new Error("WebSocket session closed");
				}
				const entry: SessionWebSocketCacheEntry = { socket, busy: false, waiters: [] };
				websocketSessionCache.set(cacheKey, entry);
				return entry;
			})
			.finally(() => {
				if (websocketConnectionPromises.get(cacheKey) === connectionPromise) {
					websocketConnectionPromises.delete(cacheKey);
				}
			});
		websocketConnectionPromises.set(cacheKey, connectionPromise);
		pendingConnection = connectionPromise;
	}
	const entry = await pendingConnection;
	if (entry.busy) return waitForCachedWebSocket(cacheKey, entry, signal);
	return acquireCachedWebSocketEntry(cacheKey, entry, false);
}
