//! Codex wire identity: UUID v7 session/thread/window identifiers and the
//! sticky-routing turn-state token, matching the Codex CLI's request identity.
//!
//! Pi's own session ids are short opaque strings (often 8 hex chars). The
//! Codex ChatGPT backend expects real UUID-shaped ids in `session-id`,
//! `thread-id`, `x-codex-window-id`, `prompt_cache_key`, and
//! `client_metadata`; the CLI generates UUID v7 values. This module derives a
//! stable UUID v7 identity per (pi session, thread) pair and remembers the
//! `x-codex-turn-state` sticky-routing token emitted by the backend so later
//! requests in the same session can replay it.

const WIRE_IDENTITY_CACHE_LIMIT = 1024;

export interface CodexWireIdentity {
	/** Stable UUID v7 for the pi session. */
	sessionId: string;
	/** Stable UUID v7 for the thread (defaults to a per-thread value). */
	threadId: string;
	/** UUID v7 for the current auto-compact window; rotated on compaction. */
	windowId: string;
}

interface CachedThread {
	threadId: string;
	windowId: string;
}

interface CachedSession {
	sessionId: string;
	threads: Map<string, CachedThread>;
}

const sessionCache = new Map<string, CachedSession>();
const turnStateCache = new Map<string, string>();

function randomBytes(count: number): Uint8Array {
	if (typeof globalThis.crypto?.getRandomValues === "function") {
		const bytes = new Uint8Array(count);
		globalThis.crypto.getRandomValues(bytes);
		return bytes;
	}
	const bytes = new Uint8Array(count);
	for (let index = 0; index < count; index++) {
		bytes[index] = Math.floor(Math.random() * 256);
	}
	return bytes;
}

function uuidBytesToHex(bytes: Uint8Array): string {
	const hex: string[] = [];
	for (const byte of bytes) {
		hex.push(byte.toString(16).padStart(2, "0"));
	}
	return [
		hex.slice(0, 4).join(""),
		hex.slice(4, 6).join(""),
		hex.slice(6, 8).join(""),
		hex.slice(8, 10).join(""),
		hex.slice(10, 16).join(""),
	].join("-");
}

/** RFC 9562 UUID v7: 48-bit millisecond timestamp + random, version 7, variant RFC 4122. */
export function uuidV7(): string {
	const bytes = randomBytes(16);
	const timestamp = Date.now();
	bytes[0] = (timestamp / 0x10000000000) & 0xff;
	bytes[1] = (timestamp / 0x100000000) & 0xff;
	bytes[2] = (timestamp / 0x1000000) & 0xff;
	bytes[3] = (timestamp / 0x10000) & 0xff;
	bytes[4] = (timestamp / 0x100) & 0xff;
	bytes[5] = timestamp & 0xff;
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	return uuidBytesToHex(bytes);
}

function newCachedSession(): CachedSession {
	return {
		sessionId: uuidV7(),
		threads: new Map(),
	};
}

function ensureSession(sessionKey: string): CachedSession {
	let session = sessionCache.get(sessionKey);
	if (!session) {
		if (sessionCache.size >= WIRE_IDENTITY_CACHE_LIMIT) {
			sessionCache.clear();
			turnStateCache.clear();
		}
		session = newCachedSession();
		sessionCache.set(sessionKey, session);
	}
	return session;
}

function ensureThread(session: CachedSession, threadKey: string): CachedThread {
	let thread = session.threads.get(threadKey);
	if (!thread) {
		thread = { threadId: uuidV7(), windowId: uuidV7() };
		session.threads.set(threadKey, thread);
	}
	return thread;
}

/**
 * Resolve the stable UUID v7 wire identity for a (session, thread) pair.
 * Values are generated once and reused for the lifetime of the pair so the
 * backend sees consistent `session-id`/`thread-id`/`x-codex-window-id` values,
 * exactly like the Codex CLI.
 */
export function resolveCodexWireIdentity(
	sessionKey: string,
	threadKey?: string,
): CodexWireIdentity {
	const session = ensureSession(sessionKey);
	const thread = ensureThread(session, threadKey ?? sessionKey);
	return {
		sessionId: session.sessionId,
		threadId: thread.threadId,
		windowId: thread.windowId,
	};
}

/**
 * Rotate the auto-compact window id for a (session, thread) pair. Session and
 * thread ids stay stable; only `x-codex-window-id` changes, mirroring the
 * CLI's auto-compact window lifecycle.
 */
export function rotateCodexWindowId(sessionKey: string, threadKey?: string): void {
	const session = ensureSession(sessionKey);
	const thread = ensureThread(session, threadKey ?? sessionKey);
	thread.windowId = uuidV7();
}

/** Current sticky-routing turn-state token for a session, if the backend issued one. */
export function codexTurnStateFor(sessionKey: string): string | undefined {
	return turnStateCache.get(sessionKey);
}

/** Remember the sticky-routing token emitted by the backend. */
export function captureCodexTurnState(sessionKey: string, token: string | undefined): void {
	if (!sessionKey || typeof token !== "string" || !token.trim()) return;
	turnStateCache.set(sessionKey, token.trim());
}

/** Forget all derived identity and turn-state state (tests, session teardown). */
export function resetCodexWireState(): void {
	sessionCache.clear();
	turnStateCache.clear();
}

/** Current number of cached identities (diagnostics/tests). */
export function codexWireIdentityCount(): number {
	return sessionCache.size;
}
