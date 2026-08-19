import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
	captureCodexTurnState,
	codexTurnStateFor,
	resetCodexWireState,
	resolveCodexWireIdentity,
	rotateCodexWindowId,
	uuidV7,
} from "../src/codex-wire-identity.js";
import { resolveCodexRequestProfile } from "../src/codex-request-profile.js";
import { buildRequestBody, buildSSEHeaders, buildWebSocketHeaders } from "../src/provider-shim.js";

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
	resetCodexWireState();
});

test("uuidV7 emits RFC 9562 UUID v7 values with a monotonic timestamp", () => {
	const before = Date.now();
	const first = uuidV7();
	const after = Date.now();
	assert.match(first, UUID_V7_PATTERN);
	// Version nibble is 7 and the variant bits are RFC 4122 (10xx).
	assert.equal(first.slice(14, 15), "7");
	assert.match(first.slice(19, 20), /[89ab]/);
	// The 48-bit millisecond timestamp prefix must sit between `before` and `after`.
	const timestamp = Number.parseInt(first.replace(/-/g, "").slice(0, 12), 16);
	assert.ok(timestamp >= before, "uuid timestamp must not predate generation");
	assert.ok(timestamp <= after, "uuid timestamp must not postdate generation");
	assert.notEqual(uuidV7(), first);
});

test("wire identity is stable per (session, thread) and distinct across pairs", () => {
	const first = resolveCodexWireIdentity("sess-1");
	const second = resolveCodexWireIdentity("sess-1");
	assert.deepEqual(first, second);
	assert.match(first.sessionId, UUID_V7_PATTERN);
	assert.match(first.threadId, UUID_V7_PATTERN);
	assert.match(first.windowId, UUID_V7_PATTERN);
	assert.notEqual(first.sessionId, first.threadId);

	const otherSession = resolveCodexWireIdentity("sess-2");
	assert.notEqual(otherSession.sessionId, first.sessionId);

	const otherThread = resolveCodexWireIdentity("sess-1", "thread-9");
	assert.equal(otherThread.sessionId, first.sessionId);
	assert.notEqual(otherThread.threadId, first.threadId);

	// The same explicit thread key resolves to the same thread id.
	assert.deepEqual(resolveCodexWireIdentity("sess-1", "thread-9"), otherThread);
});

test("rotateCodexWindowId changes only the window id", () => {
	const before = resolveCodexWireIdentity("sess-1");
	rotateCodexWindowId("sess-1");
	const after = resolveCodexWireIdentity("sess-1");
	assert.equal(after.sessionId, before.sessionId);
	assert.equal(after.threadId, before.threadId);
	assert.notEqual(after.windowId, before.windowId);
	assert.match(after.windowId, UUID_V7_PATTERN);
});

test("turn-state capture stores and replays the sticky-routing token", () => {
	assert.equal(codexTurnStateFor("sess-1"), undefined);
	captureCodexTurnState("sess-1", "  sticky-token-123  ");
	assert.equal(codexTurnStateFor("sess-1"), "sticky-token-123");
	// Blank values are ignored.
	captureCodexTurnState("sess-1", "   ");
	assert.equal(codexTurnStateFor("sess-1"), "sticky-token-123");
	assert.equal(codexTurnStateFor("sess-2"), undefined);
});

const liteProfile = resolveCodexRequestProfile({ responsesMode: "lite" });

function modelFixture(): any {
	return {
		provider: "openai",
		api: "openai-responses",
		id: "gpt-5.6-sol",
		input: ["text"],
		reasoning: true,
		thinkingLevelMap: { low: "low" },
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

function contextFixture(): any {
	return {
		messages: [{ role: "user", content: "hello" }],
		systemPrompt: undefined,
		tools: [],
	};
}

test("buildSSEHeaders emits Codex-compatible UUID v7 identity headers", () => {
	const headers = buildSSEHeaders(undefined, undefined, undefined, "token", "sess-1", liteProfile);
	const sessionId = headers.get("session-id");
	const threadId = headers.get("thread-id");
	assert.ok(sessionId && UUID_V7_PATTERN.test(sessionId));
	assert.ok(threadId && UUID_V7_PATTERN.test(threadId));
	assert.ok(headers.get("x-codex-window-id") && UUID_V7_PATTERN.test(headers.get("x-codex-window-id")!));
	assert.equal(headers.get("x-client-request-id"), threadId);
	// The legacy underscore variant is gone; Codex uses hyphenated names.
	assert.equal(headers.get("session_id"), null);
	assert.equal(headers.get("x-codex-turn-state"), null);

	// Stable across requests, aligned with the request-body prompt_cache_key.
	const again = buildSSEHeaders(undefined, undefined, undefined, "token", "sess-1", liteProfile);
	assert.equal(again.get("session-id"), sessionId);
	assert.equal(again.get("thread-id"), threadId);
	assert.equal(again.get("x-codex-window-id"), headers.get("x-codex-window-id"));

	const body = buildRequestBody(modelFixture(), contextFixture(), liteProfile, { sessionId: "sess-1" }) as any;
	assert.equal(body.prompt_cache_key, sessionId);
});

test("buildSSEHeaders replays the captured turn-state token", () => {
	captureCodexTurnState("sess-1", "sticky-token-abc");
	const headers = buildSSEHeaders(undefined, undefined, undefined, "token", "sess-1", liteProfile);
	assert.equal(headers.get("x-codex-turn-state"), "sticky-token-abc");
});

test("buildWebSocketHeaders emits the same UUID v7 identity", () => {
	const headers = buildWebSocketHeaders(undefined, undefined, undefined, "token", "sess-1", "thread-9");
	const sessionId = headers.get("session-id");
	const threadId = headers.get("thread-id");
	assert.ok(sessionId && UUID_V7_PATTERN.test(sessionId));
	assert.ok(threadId && UUID_V7_PATTERN.test(threadId));
	assert.ok(headers.get("x-codex-window-id") && UUID_V7_PATTERN.test(headers.get("x-codex-window-id")!));
	assert.equal(headers.get("x-client-request-id"), threadId);
	assert.equal(headers.get("OpenAI-Beta"), "responses_websockets=2026-02-06");

	// Same wire session as the SSE request for the same pi session.
	const sse = buildSSEHeaders(undefined, undefined, undefined, "token", "sess-1", liteProfile);
	assert.equal(sessionId, sse.get("session-id"));
});

test("buildRequestBody defaults reasoning.effort to low for Lite models", () => {
	const body = buildRequestBody(modelFixture(), contextFixture(), liteProfile, { sessionId: "sess-1" }) as any;
	assert.deepEqual(body.reasoning, { effort: "low", context: "all_turns" });

	// An explicit off stays off (no effort field).
	const off = buildRequestBody(modelFixture(), contextFixture(), liteProfile, {
		sessionId: "sess-1",
		reasoning: "off" as any,
	}) as any;
	assert.equal(off.reasoning?.effort, undefined);
	assert.equal(off.reasoning?.context, "all_turns");

	// An explicit user level still wins.
	const high = buildRequestBody(modelFixture(), contextFixture(), liteProfile, {
		sessionId: "sess-1",
		reasoning: "high" as any,
	}) as any;
	assert.equal(high.reasoning?.effort, "high");
});
