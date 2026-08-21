import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import {
	beginCodexTurn,
	captureCodexTurnState,
	codexInstallationIdFor,
	codexTurnStateFor,
	createCodexChildIdentity,
	createCodexRootIdentity,
	endCodexTurn,
	registerCodexThreadIdentity,
	resetCodexWireState,
	resolveCodexRequestIdentity,
	resolveCodexWireIdentity,
	rotateCodexWindowId,
	uuidV7,
} from "../src/codex-wire-identity.js";
import { resolveCodexRequestProfile } from "../src/codex-request-profile.js";
import {
	buildRequestBody,
	buildSSEHeaders,
	buildWebSocketHeaders,
	withSseRequestMetadata,
} from "../src/provider-shim.js";

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let installationRoot = "";

beforeEach(() => {
	installationRoot = mkdtempSync(join(tmpdir(), "pi-codex-installation-"));
	process.env.PI_CODEX_INSTALLATION_ID_PATH = join(
		installationRoot,
		"installation_id",
	);
});

afterEach(() => {
	resetCodexWireState();
	delete process.env.PI_CODEX_INSTALLATION_ID_PATH;
	rmSync(installationRoot, { recursive: true, force: true });
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
	assert.equal(first.sessionId, first.threadId);

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

test("codexInstallationIdFor is one stable installation UUID v4", () => {
	const first = codexInstallationIdFor("sess-1");
	assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	assert.equal(codexInstallationIdFor("sess-1"), first);
	assert.equal(codexInstallationIdFor("sess-2"), first);
	resetCodexWireState();
	assert.equal(codexInstallationIdFor("sess-after-restart"), first);
});

test("turn-state capture stores and replays the sticky-routing token", () => {
	assert.equal(codexTurnStateFor("sess-1"), undefined);
	beginCodexTurn("sess-1");
	captureCodexTurnState("sess-1", "  sticky-token-123  ");
	assert.equal(codexTurnStateFor("sess-1"), "sticky-token-123");
	// Blank values are ignored.
	captureCodexTurnState("sess-1", "   ");
	assert.equal(codexTurnStateFor("sess-1"), "sticky-token-123");
	assert.equal(codexTurnStateFor("sess-2"), undefined);
	endCodexTurn("sess-1");
	beginCodexTurn("sess-1");
	assert.equal(codexTurnStateFor("sess-1"), undefined);
});

test("startup prewarm turn-state transfers only to the first real turn", () => {
	captureCodexTurnState("sess-1", "prewarm-state");
	assert.equal(codexTurnStateFor("sess-1"), undefined);
	beginCodexTurn("sess-1");
	assert.equal(codexTurnStateFor("sess-1"), "prewarm-state");
	endCodexTurn("sess-1");
	beginCodexTurn("sess-1");
	assert.equal(codexTurnStateFor("sess-1"), undefined);
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

test("child requests share the root prompt cache but keep their own thread", () => {
	const root = registerCodexThreadIdentity(
		createCodexRootIdentity("pi-root"),
	);
	const child = registerCodexThreadIdentity(
		createCodexChildIdentity("pi-child", root, {
			relation: "spawn",
			agentName: "scout",
		}),
	);
	beginCodexTurn("pi-child");
	const identity = resolveCodexRequestIdentity(
		"pi-child",
		undefined,
		"turn",
	);
	assert.ok(identity);
	const body = buildRequestBody(
		modelFixture(),
		contextFixture(),
		liteProfile,
		{ sessionId: "pi-child" },
	) as any;
	const headers = buildSSEHeaders(
		undefined,
		undefined,
		undefined,
		"token",
		"pi-child",
		liteProfile,
		child.threadId,
		identity,
	);
	assert.equal(body.prompt_cache_key, root.sessionId);
	assert.equal(headers.get("session-id"), root.sessionId);
	assert.equal(headers.get("thread-id"), child.threadId);
	assert.equal(headers.get("x-client-request-id"), child.threadId);
	assert.equal(
		headers.get("x-codex-parent-thread-id"),
		root.threadId,
	);
});

test("buildSSEHeaders replays the captured turn-state token", () => {
	beginCodexTurn("sess-1");
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

test("withSseRequestMetadata injects the Codex client_metadata envelope", () => {
	const body = buildRequestBody(modelFixture(), contextFixture(), liteProfile, { sessionId: "sess-1" }) as any;
	const sse = withSseRequestMetadata(body, {
		sessionId: "sess-1",
		threadId: "sess-1",
		turnId: "0198e2c6-7a5b-7c00-9d1e-2f3a4b5c6d7e",
	}) as any;
	assert.ok(sse.client_metadata);
	assert.equal(sse.client_metadata.session_id, body.prompt_cache_key);
	assert.match(sse.client_metadata["x-codex-installation-id"], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	const turnMetadata = JSON.parse(sse.client_metadata["x-codex-turn-metadata"]);
	assert.equal(turnMetadata.request_kind, "turn");
	assert.equal(turnMetadata.turn_id, "0198e2c6-7a5b-7c00-9d1e-2f3a4b5c6d7e");
	assert.equal(turnMetadata.window_id, sse.client_metadata["x-codex-window-id"]);
	// SSE keeps the Lite/timing fields out of client_metadata.
	assert.equal(sse.client_metadata["ws_request_header_x_openai_internal_codex_responses_lite"], undefined);
	assert.equal(sse.client_metadata["x-codex-ws-stream-request-start-ms"], undefined);
	// Session-less requests stay untouched.
	assert.equal(withSseRequestMetadata(body, { turnId: "t1" }), body);
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
