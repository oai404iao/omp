import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, type TestContext } from "node:test";
import { createServer } from "node:http";
import { EventEmitter, once } from "node:events";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { isRetryableAssistantError, retryAssistantCall } from "@earendil-works/pi-ai/compat";
import { WebSocketMessageTooLargeError, streamWebSocketRequest } from "@oai404iao/pi-codex-core/internal/providers/openai-codex/websocket-events";
import { timeoutFromOption } from "@oai404iao/pi-codex-core/internal/providers/openai-codex/timeouts";
import { resetCodexWireState } from "@oai404iao/pi-codex-runtime/internal/codex-wire-identity";
import { buildWebSocketHeaders } from "@oai404iao/pi-codex-core/internal/providers/openai-codex/headers";
import { closeProviderWebSocketSessions } from "@oai404iao/pi-codex-core/internal/providers/openai-codex/websocket-session";
import { requestOpenAINativeCompaction } from "@oai404iao/pi-codex-core/internal/adapter/compaction/request";
import { resolveResponsesWebSocketUrl } from "@oai404iao/pi-codex-core/internal/providers/openai-codex/urls";
import { websocketSessionCache } from "../src/providers/openai-codex/websocket-session.js";
import { createProviderHarness as sharedProviderHarness } from "./support/openai-codex-test-support.js";
import { readJsonRequest, startWebSocketServer, successEvents } from "./support/websocket-test-support.js";
const createProviderHarness = () => sharedProviderHarness().providers;
const createProviderHarnessWithEvents = () => sharedProviderHarness({ snapshotTools: true });

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

import { loadSettings } from "@oai404iao/pi-codex-runtime/internal/settings";

const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
const settingsRoots: string[] = [];

afterEach(() => {
	resetCodexWireState();
	closeProviderWebSocketSessions();
	if (originalPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
	for (const root of settingsRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeSettings(value: Record<string, unknown>): void {
	const root = mkdtempSync(join(tmpdir(), "pi-codex-ws-settings-"));
	settingsRoots.push(root);
	const agentDir = join(root, "agent");
	const configDir = join(agentDir, "extensions", "pi-codex-minimal-tools");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(configDir, "config.json"), JSON.stringify(value));
	process.env.PI_CODING_AGENT_DIR = agentDir;
}

async function emitHandlers(
	harness: ReturnType<typeof createProviderHarnessWithEvents>,
	name: string,
	event: Record<string, unknown>,
	ctx: Record<string, any>,
): Promise<void> {
	for (const handler of harness.handlers[name] ?? []) await handler(event, ctx);
}

async function assertEventually(
	predicate: () => boolean,
	timeoutMs = 1_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) assert.fail(`Condition was not met within ${timeoutMs}ms`);
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

function providerEventContext(
	model: Record<string, any>,
	options: {
		sessionId?: string;
		systemPrompt?: string;
		thinkingLevel?: string;
		apiKey?: string;
		headers?: Record<string, string>;
	} = {},
): Record<string, any> {
	return {
		cwd: process.cwd(),
		model,
		signal: undefined,
		thinkingLevel: options.thinkingLevel,
		getSystemPrompt: () => options.systemPrompt ?? "",
		sessionManager: {
			getSessionId: () => options.sessionId ?? "pi-session",
			getBranch: () => [],
		},
		modelRegistry: {
			async getApiKeyAndHeaders() {
				return {
					ok: true,
					apiKey: options.apiKey ?? "pi-resolved-api-key",
					headers: options.headers,
				};
			},
		},
	};
}

async function runOpenAIProvider(
	provider: any,
	baseUrl: string,
	messages: any[],
	options: Record<string, unknown> = {},
): Promise<any> {
	const stream = provider.streamSimple(
		{
			provider: "openai",
			api: "openai-responses",
			id: "gpt-5.5",
			baseUrl,
			headers: {},
			input: ["text"],
			reasoning: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		},
		{ systemPrompt: "", messages, tools: [] },
		{ apiKey: "pi-resolved-api-key", sessionId: "pi-session", ...options },
	);
	return stream.result();
}

test("OpenAI WebSocket URL and headers use the normal Responses endpoint and Pi auth", () => {
	assert.equal(
		resolveResponsesWebSocketUrl("https://api.openai.com/v1", "openai"),
		"wss://api.openai.com/v1/responses",
	);
	const headers = buildWebSocketHeaders(
		{ "x-model": "model", "x-remove": "inherited" },
		{ "x-pi-auth": "resolved", "x-remove": null },
		undefined,
		"pi-key",
		"pi-session",
	);
	assert.equal(headers.get("authorization"), "Bearer pi-key");
	assert.equal(headers.get("x-pi-auth"), "resolved");
	assert.equal(headers.get("x-remove"), null);
	assert.equal(headers.get("chatgpt-account-id"), null);
	assert.equal(headers.get("openai-beta"), "responses_websockets=2026-02-06");
	const sessionId = headers.get("session-id");
	const threadId = headers.get("thread-id");
	assert.ok(sessionId && UUID_V7_PATTERN.test(sessionId));
	assert.ok(threadId && UUID_V7_PATTERN.test(threadId));
	assert.equal(threadId, sessionId);
	assert.equal(headers.get("x-client-request-id"), threadId);
	assert.equal(headers.get("x-codex-window-id"), `${headers.get("thread-id")}:0`);
});

test("cacheRetention none uses full input on fresh sockets but preserves session identity", async () => {
	writeSettings({ openaiTransport: "websocket-cached" });
	const server = await startWebSocketServer([
		() => successEvents("resp_first", "first"),
		() => successEvents("resp_second", "second"),
	]);
	try {
		const provider = createProviderHarness().openai;
		const first = await runOpenAIProvider(provider, server.url, [{ role: "user", content: "hello" }], { cacheRetention: "none" });
		const second = await runOpenAIProvider(provider, server.url, [
			{ role: "user", content: "hello" }, first, { role: "user", content: "again" },
		], { cacheRetention: "none" });
		assert.equal(second.stopReason, "stop");
		assert.equal(server.connections, 2);
		assert.equal(server.requests[0]?.prompt_cache_key, undefined);
		assert.equal(server.requests[1]?.prompt_cache_key, undefined);
		assert.equal(server.requests[1]?.previous_response_id, undefined);
		assert.equal(server.requests[1]?.input.length, 3);
		assert.ok(server.handshakes[0]?.headers["session-id"]);
		assert.equal(server.handshakes[1]?.headers["session-id"], server.handshakes[0]?.headers["session-id"]);
		assert.equal(server.handshakes[1]?.headers["thread-id"], server.handshakes[0]?.headers["thread-id"]);
	} finally {
		await server.close();
	}
});

test("WebSocket caller connect timeout bounds a stalled loopback handshake", { timeout: 3000 }, async () => {
	writeSettings({ openaiTransport: "websocket" });
	const server = createServer();
	const sockets = new Set<Socket>();
	server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
	server.on("upgrade", () => {});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	try {
		const address = server.address() as { port: number };
		const result = await runOpenAIProvider(createProviderHarness().openai, `http://127.0.0.1:${address.port}/v1`, [
			{ role: "user", content: "hello" },
		], { websocketConnectTimeoutMs: 25, maxRetries: 0, env: { NO_PROXY: "*" } });
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage, /connection timed out after 25ms/);
	} finally {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("WebSocket idle timeout honors timeoutMs after a successful upgrade", { timeout: 3000 }, async () => {
	writeSettings({ openaiTransport: "websocket" });
	const server = await startWebSocketServer([
		() => [{ type: "response.created", response: { id: "resp_stalled" } }],
	]);
	try {
		const result = await runOpenAIProvider(createProviderHarness().openai, server.url, [
			{ role: "user", content: "hello" },
		], { timeoutMs: 25, maxRetries: 0 });
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage, /idle timeout after 25ms/);
		assert.equal(server.requests.length, 1);
	} finally {
		await server.close();
	}
});

test("joining a shared stalled handshake has an independent deadline and abort", { timeout: 3000 }, async () => {
	writeSettings({ openaiTransport: "websocket" });
	const ownerAbort = new AbortController();
	const joinerAbort = new AbortController();
	const server = createServer();
	const sockets = new Set<Socket>();
	let upgraded!: () => void;
	const upgrading = new Promise<void>((resolve) => { upgraded = resolve; });
	let handshakes = 0;
	server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
	server.on("upgrade", () => { handshakes++; upgraded(); });
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const provider = createProviderHarness().openai;
	const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
	const options = { maxRetries: 0, env: { NO_PROXY: "*" }, websocketConnectTimeoutMs: 0 };
	const messages = [{ role: "user", content: "hello" }];
	const owner = runOpenAIProvider(provider, url, messages, { ...options, signal: ownerAbort.signal });
	try {
		await upgrading;
		const timedOut = await runOpenAIProvider(provider, url, messages, { ...options, websocketConnectTimeoutMs: 25 });
		assert.match(timedOut.errorMessage, /connection timed out after 25ms/);
		const joiner = runOpenAIProvider(provider, url, messages, { ...options, signal: joinerAbort.signal });
		await new Promise<void>((resolve) => setImmediate(resolve));
		joinerAbort.abort();
		assert.equal((await joiner).stopReason, "aborted");
		assert.equal(handshakes, 1);
		assert.equal(ownerAbort.signal.aborted, false);
		closeProviderWebSocketSessions("pi-session");
		assert.equal((await owner).stopReason, "error");
	} finally {
		ownerAbort.abort();
		await owner;
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

function mockWebSocket(send: (payload: string, callback?: (error?: Error) => void) => void) {
	const listeners = new Map<string, (event: unknown) => void>();
	const socket = {
		readyState: 1, send, close() {},
		addEventListener(name: string, listener: (event: unknown) => void) { listeners.set(name, listener); },
		removeEventListener(name: string) { listeners.delete(name); },
	};
	return { socket, listeners };
}

test("zero disables WS idle timer; invalid timeouts fail before I/O", async (t) => {
	assert.equal(timeoutFromOption(undefined, 15000, "timeout"), 15000);
	assert.equal(timeoutFromOption(0, 15000, "timeout"), 0);
	for (const invalid of [-1, Number.NaN, Infinity]) {
		assert.throws(() => timeoutFromOption(invalid, 15000, "timeout"), /Invalid timeout/);
	}
	const { socket, listeners } = mockWebSocket((_payload, callback) => callback?.());
	const timer = t.mock.method(globalThis, "setTimeout");
	const iterator = streamWebSocketRequest(socket, "{}", undefined, 0, 42)[Symbol.asyncIterator]();
	const next = iterator.next();
	listeners.get("message")?.({ data: JSON.stringify({ type: "response.completed", response: { status: "completed" } }) });
	assert.equal((await next).value.type, "response.completed");
	await iterator.return?.();
	assert.deepEqual(timer.mock.calls.map(call => call.arguments[1]), [42]);
	assert.equal(listeners.size, 0);
});

test("provider NO_PROXY overrides a supplied WS proxy without touching ambient settings", async () => {
	writeSettings({ openaiTransport: "websocket" });
	const server = await startWebSocketServer([() => successEvents("resp_direct", "direct")]);
	try {
		const result = await runOpenAIProvider(createProviderHarness().openai, server.url, [
			{ role: "user", content: "hello" },
		], { env: { HTTP_PROXY: "http://127.0.0.1:1", NO_PROXY: "*" }, maxRetries: 0 });
		assert.equal(result.stopReason, "stop");
		assert.equal(server.connections, 1);
	} finally {
		await server.close();
	}
});

test("WebSocket write without a callback is bounded by the send deadline", async () => {
	const { socket, listeners } = mockWebSocket(() => {});
	await assert.rejects(
		streamWebSocketRequest(socket, "{}", undefined, 0, 5)[Symbol.asyncIterator]().next(),
		/OpenAI Responses WebSocket send timed out after 5ms/,
	);
	assert.equal(listeners.size, 0);
});

test("WebSocket peer 1009 still wins when the write callback fails first", async () => {
	const { socket, listeners } = mockWebSocket((_payload, callback) => callback?.(new Error("write EPIPE")));
	const result = streamWebSocketRequest(socket, "{}", undefined, 0)[Symbol.asyncIterator]().next();
	await new Promise<void>(resolve => setImmediate(resolve));
	listeners.get("close")?.({ code: 1009 });
	await assert.rejects(result, error => error instanceof WebSocketMessageTooLargeError && error.beforeResponseText);
	assert.equal(listeners.size, 0);
});

test("WebSocket peer 1009 still wins when a transport error follows a successful write", async () => {
	const { socket, listeners } = mockWebSocket((_payload, callback) => callback?.());
	const result = streamWebSocketRequest(socket, "{}", undefined)[Symbol.asyncIterator]().next();
	listeners.get("error")?.(new Error("connection reset"));
	await new Promise<void>(resolve => setImmediate(resolve));
	listeners.get("close")?.({ code: 1009 });
	await assert.rejects(result, error => error instanceof WebSocketMessageTooLargeError && error.beforeResponseText);
	assert.equal(listeners.size, 0);
});

test("WebSocket local receive-size errors are not treated as a rejected request", async () => {
	const { socket, listeners } = mockWebSocket((_payload, callback) => callback?.());
	const result = streamWebSocketRequest(socket, "{}", undefined)[Symbol.asyncIterator]().next();
	listeners.get("error")?.(Object.assign(new Error("Max payload size exceeded"), { code: "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH" }));
	listeners.get("close")?.({ code: 1009 });
	await assert.rejects(result, /^Error: Max payload size exceeded$/);
	assert.equal(listeners.size, 0);
});

test("WebSocket response text before the write callback rules out early 1009 fallback", async () => {
	const { socket, listeners } = mockWebSocket(() => {
		listeners.get("message")?.({ data: '{"type":"response.created","response":{"id":"started"}}' });
		listeners.get("close")?.({ code: 1009 });
	});
	const iterator = streamWebSocketRequest(socket, "{}", undefined, 0)[Symbol.asyncIterator]();
	assert.equal((await iterator.next()).value.type, "response.created");
	await assert.rejects(iterator.next(), error => error instanceof WebSocketMessageTooLargeError && !error.beforeResponseText);
	assert.equal(listeners.size, 0);
});

test("WebSocket write failure without a close remains a write error", async () => {
	const { socket, listeners } = mockWebSocket((_payload, callback) => callback?.(new Error("write EPIPE")));
	await assert.rejects(
		streamWebSocketRequest(socket, "{}", undefined, 0, 5)[Symbol.asyncIterator]().next(),
		/Failed to send OpenAI Responses WebSocket request: write EPIPE/,
	);
	assert.equal(listeners.size, 0);
});

test("WebSocket write failure followed by abort does not wait for a close", async () => {
	const { socket, listeners } = mockWebSocket((_payload, callback) => callback?.(new Error("write EPIPE")));
	const abort = new AbortController();
	const result = streamWebSocketRequest(socket, "{}", abort.signal, 0)[Symbol.asyncIterator]().next();
	abort.abort();
	await assert.rejects(result, /Request was aborted/);
	assert.equal(listeners.size, 0);
});

test("openai websocket transport performs an authenticated response.create request", async () => {
	writeSettings({ openaiTransport: "websocket" });
	const server = await startWebSocketServer([
		() => successEvents("resp_1", "hello over websocket"),
	]);
	try {
		const provider = createProviderHarness().openai;
		const result = await runOpenAIProvider(provider, server.url, [{ role: "user", content: "hello" }], {
			headers: { "x-pi-auth": "resolved" },
			transformHeaders: (headers: Record<string, string | null>) => ({
				...headers,
				"x-inline-header": "enabled",
			}),
		});

		assert.equal(result.stopReason, "stop");
		assert.equal(result.content[0]?.text, "hello over websocket");
		assert.equal(server.connections, 1);
		assert.equal(server.requests.length, 1);
		assert.equal(server.requests[0]?.type, "response.create");
		assert.equal(server.requests[0]?.model, "gpt-5.5");
		const handshakeHeaders = server.handshakes[0]?.headers as Record<string, string> | undefined;
		const wireSessionId = handshakeHeaders?.["session-id"];
		const wireThreadId = handshakeHeaders?.["thread-id"];
		assert.ok(wireSessionId && UUID_V7_PATTERN.test(wireSessionId));
		assert.ok(wireThreadId && UUID_V7_PATTERN.test(wireThreadId));
		assert.equal(server.requests[0]?.client_metadata?.session_id, wireSessionId);
		assert.equal(server.requests[0]?.client_metadata?.thread_id, wireThreadId);
		assert.equal(
			server.requests[0]?.client_metadata?.["x-codex-window-id"],
			handshakeHeaders?.["x-codex-window-id"],
		);
		assert.match(
			server.requests[0]?.client_metadata?.["x-codex-installation-id"] ?? "",
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		const wsTurnMetadata = JSON.parse(server.requests[0]?.client_metadata?.["x-codex-turn-metadata"] ?? "{}");
		assert.equal(wsTurnMetadata.request_kind, "turn");
		assert.equal(wsTurnMetadata.session_id, wireSessionId);
		assert.equal(wsTurnMetadata.installation_id, server.requests[0]?.client_metadata?.["x-codex-installation-id"]);
		assert.equal(typeof server.requests[0]?.client_metadata?.turn_id, "string");
		assert.match(server.requests[0]?.client_metadata?.["x-codex-ws-stream-request-start-ms"], /^\d+$/);
		assert.equal(server.handshakes[0]?.headers.authorization, "Bearer pi-resolved-api-key");
		assert.equal(server.handshakes[0]?.headers["x-pi-auth"], "resolved");
		assert.equal(
			server.handshakes[0]?.headers["x-inline-header"],
			"enabled",
		);
		assert.equal(server.handshakes[0]?.headers["openai-beta"], "responses_websockets=2026-02-06");
		assert.equal(server.handshakes[0]?.headers["x-client-request-id"], wireThreadId);
	} finally {
		await server.close();
	}
});

test("explicit Pi request metadata supplies the WebSocket turn identity", async () => {
	writeSettings({ openaiTransport: "websocket" });
	const server = await startWebSocketServer([
		() => successEvents("resp_1", "ok"),
	]);
	try {
		const provider = createProviderHarness().openai;
		const explicitSessionId = "0198e2c6-7a5b-7c00-9d1e-2f3a4b5c6d7e";
		const explicitThreadId = "0198e2c6-7a5b-7c01-9d1e-2f3a4b5c6d7e";
		const explicitTurnId = "0198e2c6-7a5b-7c02-9d1e-2f3a4b5c6d7e";
		const result = await runOpenAIProvider(provider, server.url, [{ role: "user", content: "hello" }], {
			metadata: {
				session_id: explicitSessionId,
				thread_id: explicitThreadId,
				turn_id: explicitTurnId,
			},
		});

		assert.equal(result.stopReason, "stop");
		const handshakeHeaders = server.handshakes[0]?.headers as Record<string, string> | undefined;
		const wireSessionId = handshakeHeaders?.["session-id"];
		const wireThreadId = handshakeHeaders?.["thread-id"];
		assert.equal(wireSessionId, explicitSessionId);
		assert.equal(wireThreadId, explicitThreadId);
		assert.equal(handshakeHeaders?.["x-client-request-id"], wireThreadId);
		assert.equal(server.requests[0]?.client_metadata?.session_id, wireSessionId);
		assert.equal(server.requests[0]?.client_metadata?.thread_id, wireThreadId);
		assert.equal(server.requests[0]?.client_metadata?.turn_id, explicitTurnId);
	} finally {
		await server.close();
	}
});

test("Pi agent lifecycle keeps one turn_id across tool-loop and automatic retry requests", async () => {
	writeSettings({ openaiTransport: "websocket" });
	const server = await startWebSocketServer([
		() => successEvents("resp_1", "first"),
		() => successEvents("resp_2", "second"),
		() => successEvents("resp_3", "third"),
	]);
	try {
		const harness = createProviderHarnessWithEvents();
		const ctx = { sessionManager: { getSessionId: () => "pi-session" } };
		for (const handler of harness.handlers.before_agent_start ?? []) {
			await handler({ type: "before_agent_start", prompt: "hello" }, ctx);
		}

		await runOpenAIProvider(harness.providers.openai, server.url, [{ role: "user", content: "hello" }]);
		await runOpenAIProvider(harness.providers.openai, server.url, [{ role: "user", content: "again" }]);

		const firstTurnId = server.requests[0]?.client_metadata?.turn_id;
		const secondTurnId = server.requests[1]?.client_metadata?.turn_id;
		assert.equal(typeof firstTurnId, "string");
		assert.equal(secondTurnId, firstTurnId);

		for (const handler of harness.handlers.agent_end ?? []) {
			await handler({ type: "agent_end", messages: [] }, ctx);
		}
		await runOpenAIProvider(harness.providers.openai, server.url, [{ role: "user", content: "automatic retry" }]);
		assert.equal(server.requests[2]?.client_metadata?.turn_id, firstTurnId);
	} finally {
		await server.close();
	}
});

test("Pi-resolved Authorization header overrides the fallback API key", async () => {
	writeSettings({ openaiTransport: "websocket" });
	const server = await startWebSocketServer([
		() => successEvents("resp_1", "ok"),
	]);
	try {
		const provider = createProviderHarness().openai;
		const result = await runOpenAIProvider(provider, server.url, [{ role: "user", content: "hello" }], {
			headers: { Authorization: "Bearer pi-header-token" },
		});

		assert.equal(result.stopReason, "stop");
		assert.equal(server.handshakes[0]?.headers.authorization, "Bearer pi-header-token");
	} finally {
		await server.close();
	}
});

test("Pi-resolved Authorization header can authenticate without an API-key value", async () => {
	writeSettings({ openaiTransport: "websocket" });
	const server = await startWebSocketServer([
		() => successEvents("resp_1", "ok"),
	]);
	try {
		const provider = createProviderHarness().openai;
		const stream = provider.streamSimple(
			{
				provider: "openai",
				api: "openai-responses",
				id: "gpt-5.5",
				baseUrl: server.url,
				headers: {},
				input: ["text"],
				reasoning: false,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
			{ systemPrompt: "", messages: [{ role: "user", content: "hello" }], tools: [] },
			{
				headers: { Authorization: "Bearer pi-header-token" },
				sessionId: "pi-session",
			},
		);
		const result = await stream.result();

		assert.equal(result.stopReason, "stop");
		assert.equal(server.handshakes[0]?.headers.authorization, "Bearer pi-header-token");
	} finally {
		await server.close();
	}
});

test("request-level null Authorization removes stale model authentication", async () => {
	writeSettings({ openaiTransport: "websocket" });
	const server = await startWebSocketServer([
		() => successEvents("resp_1", "unexpected"),
	]);
	try {
		const provider = createProviderHarness().openai;
		const stream = provider.streamSimple(
			{
				provider: "openai",
				api: "openai-responses",
				id: "gpt-5.5",
				baseUrl: server.url,
				headers: { Authorization: "Bearer stale-model-token" },
				input: ["text"],
				reasoning: false,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
			{ systemPrompt: "", messages: [{ role: "user", content: "hello" }], tools: [] },
			{
				headers: { Authorization: null },
				sessionId: "pi-session",
			},
		);
		const result = await stream.result();

		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /No request authentication/);
		assert.equal(server.handshakes.length, 0);
	} finally {
		await server.close();
	}
});

test("request-level null Authorization suppresses bearer fallback with alternate auth", async () => {
	writeSettings({ openaiTransport: "websocket" });
	const server = await startWebSocketServer([
		() => successEvents("resp_1", "ok"),
	]);
	try {
		const provider = createProviderHarness().openai;
		const result = await runOpenAIProvider(provider, server.url, [{ role: "user", content: "hello" }], {
			headers: {
				Authorization: null,
				"x-api-key": "proxy-key",
			},
		});

		assert.equal(result.stopReason, "stop");
		assert.equal(server.handshakes[0]?.headers.authorization, undefined);
		assert.equal(server.handshakes[0]?.headers["x-api-key"], "proxy-key");
	} finally {
		await server.close();
	}
});

test("model Authorization does not override Pi's resolved API key", async () => {
	writeSettings({ openaiTransport: "websocket" });
	const server = await startWebSocketServer([
		() => successEvents("resp_1", "ok"),
	]);
	try {
		const provider = createProviderHarness().openai;
		const stream = provider.streamSimple(
			{
				provider: "openai",
				api: "openai-responses",
				id: "gpt-5.5",
				baseUrl: server.url,
				headers: { Authorization: "Bearer stale-model-token" },
				input: ["text"],
				reasoning: false,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
			{ systemPrompt: "", messages: [{ role: "user", content: "hello" }], tools: [] },
			{ apiKey: "pi-resolved-api-key", sessionId: "pi-session" },
		);
		const result = await stream.result();

		assert.equal(result.stopReason, "stop");
		assert.equal(server.handshakes[0]?.headers.authorization, "Bearer pi-resolved-api-key");
	} finally {
		await server.close();
	}
});

test("openai websocket reconnects once when the server reports its connection limit", async () => {
	writeSettings({ openaiTransport: "websocket" });
	const server = await startWebSocketServer([
		() => [{
			type: "error",
			status: 400,
			error: {
				type: "invalid_request_error",
				code: "websocket_connection_limit_reached",
				message: "Create a new WebSocket connection to continue.",
			},
		}],
		() => successEvents("resp_2", "reconnected"),
	]);
	try {
		const provider = createProviderHarness().openai;
		const result = await runOpenAIProvider(provider, server.url, [{ role: "user", content: "hello" }]);

		assert.equal(result.stopReason, "stop");
		assert.equal(result.content[0]?.text, "reconnected");
		assert.equal(server.connections, 2);
		assert.equal(server.requests.length, 2);
	} finally {
		await server.close();
	}
});

test("openai websocket-cached reuses the connection and sends an incremental input delta", async () => {
	writeSettings({ openaiTransport: "websocket-cached" });
	const server = await startWebSocketServer([
		() => successEvents("resp_1", "first"),
		() => successEvents("resp_2", "second"),
	]);
	try {
		const provider = createProviderHarness().openai;
		const first = await runOpenAIProvider(provider, server.url, [{ role: "user", content: "hello" }]);
		assert.equal(first.stopReason, "stop");
		const second = await runOpenAIProvider(provider, server.url, [
			{ role: "user", content: "hello" },
			first,
			{ role: "user", content: "again" },
		]);
		assert.equal(second.stopReason, "stop");

		assert.equal(server.connections, 1);
		assert.equal(server.requests.length, 2);
		assert.equal(server.requests[1]?.previous_response_id, "resp_1");
		assert.equal(server.requests[1]?.input.length, 1);
		assert.equal(server.requests[1]?.input[0]?.role, "user");
		assert.equal(server.requests[1]?.input[0]?.content[0]?.text, "again");
	} finally {
		await server.close();
	}
});

test("OpenAI Responses compaction reuses the cached WebSocket continuation", async () => {
	writeSettings({ openaiTransport: "websocket-cached", compactionMode: "responses" });
	const compactionItem = {
		type: "compaction",
		id: "cmp_1",
		encrypted_content: "opaque-compaction-state",
	};
	const server = await startWebSocketServer([
		() => successEvents("resp_1", "first"),
		() => [
			{ type: "response.created", response: { id: "resp_compact" } },
			{ type: "response.output_item.done", output_index: 0, item: compactionItem },
			{
				type: "response.completed",
				response: {
					id: "resp_compact",
					status: "completed",
					output: [compactionItem],
					usage: {
						input_tokens: 0,
						output_tokens: 0,
						total_tokens: 0,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		],
		() => successEvents("resp_after", "after compaction"),
	]);
	const model = {
		provider: "openai",
		api: "openai-responses",
		id: "gpt-5.5",
		baseUrl: server.url,
		headers: {},
		input: ["text"],
		reasoning: false,
		contextWindow: 400_000,
		maxTokens: 16_384,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} as any;
	try {
		const compactionTurnId =
			"0198e2c6-7a5b-7c03-9d1e-2f3a4b5c6d7e";
		const provider = createProviderHarness().openai;
		const first = await runOpenAIProvider(provider, server.url, [{ role: "user", content: "hello" }]);
		const output = await requestOpenAINativeCompaction(model, {
			systemPrompt: "",
			messages: [
				{ role: "user", content: "hello", timestamp: 1 },
				first,
			],
			tools: [],
		}, {
			mode: "responses",
			apiKey: "pi-resolved-api-key",
			sessionId: "pi-session",
			turnId: compactionTurnId,
			settings: loadSettings(),
		});

		assert.deepEqual(output, [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
			compactionItem,
		]);
		assert.equal(server.connections, 1);
		assert.equal(server.requests.length, 2);
		assert.equal(server.requests[1]?.type, "response.create");
		assert.equal(server.requests[1]?.previous_response_id, "resp_1");
		assert.deepEqual(server.requests[1]?.input, [{ type: "compaction_trigger" }]);
		assert.equal(
			server.requests[1]?.client_metadata?.turn_id,
			compactionTurnId,
		);
		assert.equal(server.handshakes[0]?.headers["x-codex-beta-features"], "remote_compaction_v2");

		const checkpointMessage = {
			role: "assistant",
			content: output.map((checkpointItem) => ({
				type: "thinking",
				thinking: "",
				thinkingSignature: JSON.stringify(checkpointItem),
				redacted: true,
			})),
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const after = await runOpenAIProvider(provider, server.url, [
			checkpointMessage,
			{ role: "user", content: "continue after compaction" },
		]);
		assert.equal(after.content[0]?.text, "after compaction");
		assert.equal(server.connections, 1);
		assert.equal(server.requests[2]?.previous_response_id, undefined);
		assert.equal(server.requests[2]?.input.at(-1)?.content[0]?.text, "continue after compaction");
	} finally {
		await server.close();
	}
});

test("OpenAI Responses WebSocket compaction retries a missing continuation with full context", async () => {
	writeSettings({ openaiTransport: "websocket-cached", compactionMode: "responses" });
	const compactionItem = { type: "compaction", encrypted_content: "recovered-state" };
	const server = await startWebSocketServer([
		() => successEvents("resp_1", "first"),
		() => [{
			type: "error",
			status: 400,
			error: {
				type: "invalid_request_error",
				code: "previous_response_not_found",
				message: "Previous response was not found.",
			},
		}],
		() => [
			{ type: "response.created", response: { id: "resp_compact" } },
			{ type: "response.output_item.done", output_index: 0, item: compactionItem },
			{
				type: "response.completed",
				response: {
					id: "resp_compact",
					status: "completed",
					output: [compactionItem],
					usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
				},
			},
		],
	]);
	const model = {
		provider: "openai",
		api: "openai-responses",
		id: "gpt-5.5",
		baseUrl: server.url,
		headers: {},
		input: ["text"],
		reasoning: false,
		contextWindow: 400_000,
		maxTokens: 16_384,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} as any;
	try {
		const provider = createProviderHarness().openai;
		const first = await runOpenAIProvider(provider, server.url, [{ role: "user", content: "hello" }]);
		await requestOpenAINativeCompaction(model, {
			systemPrompt: "",
			messages: [
				{ role: "user", content: "hello", timestamp: 1 },
				first,
			],
			tools: [],
		}, {
			mode: "responses",
			apiKey: "pi-resolved-api-key",
			sessionId: "pi-session",
			settings: loadSettings(),
		});

		assert.equal(server.connections, 2);
		assert.equal(server.requests[1]?.previous_response_id, "resp_1");
		assert.equal(server.requests[2]?.previous_response_id, undefined);
		assert.equal(server.requests[2]?.input.at(-1)?.type, "compaction_trigger");
		assert.equal(server.requests[2]?.input.length, 3);
	} finally {
		await server.close();
	}
});

test("strict OpenAI Responses WebSocket compaction opportunistically reuses exact continuation", async () => {
	writeSettings({ openaiTransport: "websocket", compactionMode: "responses" });
	const compactionItem = { type: "compaction", encrypted_content: "strict-state" };
	const server = await startWebSocketServer([
		() => successEvents("resp_1", "first"),
		() => [
			{ type: "response.created", response: { id: "resp_compact" } },
			{ type: "response.output_item.done", output_index: 0, item: compactionItem },
			{
				type: "response.completed",
				response: {
					id: "resp_compact",
					status: "completed",
					output: [compactionItem],
					usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
				},
			},
		],
	]);
	const model = {
		provider: "openai",
		api: "openai-responses",
		id: "gpt-5.5",
		baseUrl: server.url,
		headers: {},
		input: ["text"],
		reasoning: false,
		contextWindow: 400_000,
		maxTokens: 16_384,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} as any;
	try {
		const first = await runOpenAIProvider(
			createProviderHarness().openai,
			server.url,
			[{ role: "user", content: "hello" }],
		);
		await requestOpenAINativeCompaction(model, {
			systemPrompt: "",
			messages: [
				{ role: "user", content: "hello", timestamp: 1 },
				first,
			],
			tools: [],
		}, {
			mode: "responses",
			apiKey: "pi-resolved-api-key",
			sessionId: "pi-session",
			settings: loadSettings(),
		});

		assert.equal(server.connections, 1);
		assert.equal(server.requests[1]?.previous_response_id, "resp_1");
		assert.deepEqual(server.requests[1]?.input, [{ type: "compaction_trigger" }]);
		assert.equal(server.requests[1]?.input.at(-1)?.type, "compaction_trigger");
	} finally {
		await server.close();
	}
});

test("strict OpenAI Responses WebSocket compaction can consume a prewarm continuation", async () => {
	writeSettings({
		openaiTransport: "websocket",
		openaiWebSocketPrewarm: true,
		compactionMode: "responses",
	});
	const compactionItem = { type: "compaction", encrypted_content: "prewarm-state" };
	const server = await startWebSocketServer([
		() => successEvents("warm_1"),
		() => [
			{ type: "response.created", response: { id: "resp_compact" } },
			{ type: "response.output_item.done", output_index: 0, item: compactionItem },
			{
				type: "response.completed",
				response: {
					id: "resp_compact",
					status: "completed",
					output: [compactionItem],
					usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
				},
			},
		],
	]);
	const model = {
		provider: "openai",
		api: "openai-responses",
		id: "gpt-5.5",
		baseUrl: server.url,
		headers: {},
		input: ["text"],
		reasoning: false,
		contextWindow: 400_000,
		maxTokens: 16_384,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} as any;
	try {
		const harness = createProviderHarnessWithEvents();
		const ctx = providerEventContext(model, { headers: {} });
		await emitHandlers(harness, "session_start", { type: "session_start", reason: "startup" }, ctx);
		await assertEventually(() => server.requests.length === 1);
		await requestOpenAINativeCompaction(model, {
			systemPrompt: "",
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
			tools: [],
		}, {
			mode: "responses",
			apiKey: "pi-resolved-api-key",
			sessionId: "pi-session",
			settings: loadSettings(),
		});

		assert.equal(server.connections, 1);
		assert.equal(server.requests[0]?.generate, false);
		assert.equal(server.requests[1]?.previous_response_id, "warm_1");
		assert.equal(server.requests[1]?.input[0]?.content[0]?.text, "hello");
		assert.equal(server.requests[1]?.input[1]?.type, "compaction_trigger");
	} finally {
		await server.close();
	}
});

test("OpenAI Responses WebSocket compaction accepts Pi-resolved Authorization without an API key", async () => {
	writeSettings({ openaiTransport: "websocket", compactionMode: "responses" });
	const compactionItem = { type: "compaction", encrypted_content: "header-auth-state" };
	const server = await startWebSocketServer([
		() => [
			{ type: "response.created", response: { id: "resp_compact" } },
			{ type: "response.output_item.done", output_index: 0, item: compactionItem },
			{
				type: "response.completed",
				response: {
					id: "resp_compact",
					status: "completed",
					output: [compactionItem],
					usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
				},
			},
		],
	]);
	try {
		await requestOpenAINativeCompaction({
			provider: "openai",
			api: "openai-responses",
			id: "gpt-5.5",
			baseUrl: server.url,
			headers: {},
			input: ["text"],
			reasoning: false,
			contextWindow: 400_000,
			maxTokens: 16_384,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		} as any, {
			systemPrompt: "",
			messages: [{ role: "user", content: "compact me", timestamp: 1 }],
			tools: [],
		}, {
			mode: "responses",
			apiKey: "",
			headers: { Authorization: "Bearer pi-header-token" },
			sessionId: "pi-session",
			settings: loadSettings(),
		});

		assert.equal(server.handshakes[0]?.headers.authorization, "Bearer pi-header-token");
		assert.equal(server.requests[0]?.input.at(-1)?.type, "compaction_trigger");
	} finally {
		await server.close();
	}
});

for (const scenario of ["upgrade rejected", "early size close", "size close after text"] as const) test(`OpenAI Responses compaction auto transport: ${scenario}`, async () => {
	writeSettings({ openaiTransport: "auto", compactionMode: "responses" });
	let sseRequests = 0;
	const compactionItem = { type: "compaction", encrypted_content: "fallback-state" };
	const sticky = scenario === "upgrade rejected";
	const lateClose = scenario === "size close after text";
	const server = await startWebSocketServer([
		() => sticky ? { handshakeStatus: 426 } : [
			...(lateClose ? [{ $rawText: "not json" }] : []),
			{ $close: 1009 },
		],
		() => successEvents("resp_ws", "continued over websocket"),
	], (request, response) => {
		if (request.method !== "POST" || request.url !== "/v1/responses") {
			response.writeHead(404).end();
			return;
		}
		void (async () => {
			const body = await readJsonRequest(request, response);
			sseRequests++;
			const isCompaction = body.input?.at(-1)?.type === "compaction_trigger";
			const events = isCompaction
				? [
						{ type: "response.created", response: { id: "resp_compact" } },
						{ type: "response.output_item.done", output_index: 0, item: compactionItem },
						{
							type: "response.completed",
							response: {
								id: "resp_compact",
								status: "completed",
								output: [compactionItem],
								usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
							},
						},
					]
				: successEvents("resp_sse", "continued over sse");
			for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
			response.end();
		})();
	});
	const model = {
		provider: "openai",
		api: "openai-responses",
		id: "gpt-5.5",
		baseUrl: server.url,
		headers: {},
		input: ["text"],
		reasoning: false,
		contextWindow: 400_000,
		maxTokens: 16_384,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} as any;
	try {
		const compacted = requestOpenAINativeCompaction(model, {
			systemPrompt: "",
			messages: [{ role: "user", content: "compact me", timestamp: 1 }],
			tools: [],
		}, {
			mode: "responses",
			apiKey: "pi-resolved-api-key",
			sessionId: "pi-session",
			settings: loadSettings(),
			maxRetries: 1,
			maxRetryDelayMs: 5_500,
		});
		if (lateClose) {
			await assert.rejects(compacted, /after response text arrived \(close code 1009\)/);
		} else {
			assert.deepEqual((await compacted).at(-1), compactionItem);
		}
		const result = await runOpenAIProvider(
			createProviderHarness().openai,
			server.url,
			[{ role: "user", content: "after compact" }],
		);

		assert.equal(result.content[0]?.text, sticky ? "continued over sse" : "continued over websocket");
		assert.equal(server.connections, sticky ? 1 : 2);
		assert.equal(server.requests.length, sticky ? 0 : 2);
		assert.equal(sseRequests, sticky ? 2 : lateClose ? 0 : 1);
	} finally {
		await server.close();
	}
});

test("openai websocket preserves HTTP status and usage-limit details from error envelopes", async () => {
	writeSettings({ openaiTransport: "websocket" });
	const server = await startWebSocketServer([
		() => [{
			type: "error",
			status_code: 429,
			error: {
				type: "usage_limit_reached",
				plan_type: "PRO",
				message: "quota exceeded",
			},
		}],
	]);
	try {
		const provider = createProviderHarness().openai;
		const result = await runOpenAIProvider(provider, server.url, [{ role: "user", content: "hello" }]);

		assert.equal(result.stopReason, "error");
		assert.equal(result.errorMessage, "HTTP 429: You have hit your OpenAI usage limit (pro plan).");
		assert.equal(server.requests.length, 1);
	} finally {
		await server.close();
	}
});

test("openai websocket retries generic HTTP 429 envelopes before streaming starts", async () => {
	writeSettings({ openaiTransport: "websocket" });
	const server = await startWebSocketServer([
		() => [{
			type: "error",
			status: 429,
			error: {
				type: "rate_limit_exceeded",
				code: "rate_limit_exceeded",
				message: "Please slow down.",
			},
		}],
		() => successEvents("resp_2", "retried"),
	]);
	try {
		const provider = createProviderHarness().openai;
		const result = await runOpenAIProvider(provider, server.url, [{ role: "user", content: "hello" }], {
			maxRetries: 1,
			maxRetryDelayMs: 1_000,
		});
		assert.equal(result.stopReason, "stop");
		assert.equal(result.content[0]?.text, "retried");
		assert.equal(server.connections, 2);
	} finally {
		await server.close();
	}
});

test("openai auto falls back to SSE when the WebSocket handshake fails", async () => {
	writeSettings({ openaiTransport: "auto" });
	let sseRequestBody: any;
	const sseEvents = successEvents("resp_sse", "fell back");
	const server = await startWebSocketServer([
		() => ({ handshakeStatus: 426 }),
	], (request, response) => {
		if (request.method !== "POST" || request.url !== "/v1/responses") {
			response.writeHead(404).end();
			return;
		}
		const chunks: Buffer[] = [];
		request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
		request.on("end", () => {
			sseRequestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			response.writeHead(200, { "content-type": "text/event-stream" });
			for (const item of sseEvents) {
				response.write(`data: ${JSON.stringify(item)}\n\n`);
			}
			response.end();
		});
	});
	try {
		const provider = createProviderHarness().openai;
		const result = await runOpenAIProvider(provider, server.url, [{ role: "user", content: "hello" }]);
		assert.equal(result.stopReason, "stop");
		assert.equal(result.content[0]?.text, "fell back");
		assert.equal(sseRequestBody.model, "gpt-5.5");
	} finally {
		await server.close();
	}
});

test("openai auto does not fall back after the WebSocket stream has started", async () => {
	writeSettings({ openaiTransport: "auto" });
	const server = await startWebSocketServer([
		() => [{
			type: "response.created",
			response: { id: "resp_partial" },
		}, {
			type: "response.failed",
			response: { error: { code: "invalid_prompt", message: "synthetic failure" } },
		}],
	]);
	try {
		const provider = createProviderHarness().openai;
		const result = await runOpenAIProvider(provider, server.url, [{ role: "user", content: "hello" }]);
		assert.equal(result.stopReason, "error");
		assert.equal(result.errorMessage, "synthetic failure");
		assert.equal(server.requests.length, 1);
	} finally {
		await server.close();
	}
});

test("openai auto keeps context-limit model errors on WebSocket", async () => {
	writeSettings({ openaiTransport: "auto" });
	let sseRequests = 0;
	const server = await startWebSocketServer([
		() => [{
			type: "response.failed",
			response: {
				error: {
					code: "context_length_exceeded",
					message: "maximum context length exceeded",
				},
			},
		}],
		() => successEvents("resp_ws", "continued over websocket"),
	], (request, response) => {
		if (request.method !== "POST" || request.url !== "/v1/responses") {
			response.writeHead(404).end();
			return;
		}
		sseRequests++;
		response.writeHead(500).end();
	});
	try {
		const provider = createProviderHarness().openai;
		const failed = await runOpenAIProvider(provider, server.url, [{ role: "user", content: "too much context" }]);
		const next = await runOpenAIProvider(provider, server.url, [{ role: "user", content: "shorter context" }]);

		assert.equal(failed.stopReason, "error");
		assert.equal(failed.errorMessage, "maximum context length exceeded");
		assert.equal(next.content[0]?.text, "continued over websocket");
		assert.equal(server.connections, 2);
		assert.equal(sseRequests, 0);
	} finally {
		await server.close();
	}
});

test("openai auto keeps output-limit completions on WebSocket", async () => {
	writeSettings({ openaiTransport: "auto" });
	let sseRequests = 0;
	const server = await startWebSocketServer([
		() => [{
			type: "response.incomplete",
			response: {
				id: "resp_incomplete",
				status: "incomplete",
				incomplete_details: { reason: "max_output_tokens" },
				output: [],
				usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
			},
		}],
		() => successEvents("resp_ws", "continued over websocket"),
	], (request, response) => {
		if (request.method !== "POST" || request.url !== "/v1/responses") {
			response.writeHead(404).end();
			return;
		}
		sseRequests++;
		response.writeHead(500).end();
	});
	try {
		const provider = createProviderHarness().openai;
		const incomplete = await runOpenAIProvider(provider, server.url, [{ role: "user", content: "long answer" }]);
		const next = await runOpenAIProvider(provider, server.url, [{ role: "user", content: "continue" }]);

		assert.equal(incomplete.stopReason, "length");
		assert.equal(next.content[0]?.text, "continued over websocket");
		assert.equal(server.connections, 1);
		assert.equal(sseRequests, 0);
	} finally {
		await server.close();
	}
});

for (const terminal of [
	{ status: "cancelled" },
	{ status: "incomplete", incomplete_details: { reason: "content_filter" } },
	{ status: "incomplete" },
]) {
	test(`openai auto rejects ${JSON.stringify(terminal)} without caching or HTTP fallback`, async () => {
		writeSettings({ openaiTransport: "auto" });
		let sseRequests = 0;
		const server = await startWebSocketServer([
			() => [{
				type: "response.completed",
				response: { id: "resp_invalid", output: [], ...terminal },
			}],
			() => successEvents("resp_next", "next"),
		], (_request, response) => {
			sseRequests++;
			response.writeHead(500).end();
		});
		try {
			const provider = createProviderHarness().openai;
			const failed = await runOpenAIProvider(provider, server.url, [{ role: "user", content: "hello" }]);
			assert.equal(failed.stopReason, "error");
			assert.ok(failed.errorMessage);
			assert.equal(server.requests.length, 1);
			const next = await runOpenAIProvider(provider, server.url, [{ role: "user", content: "hello" }]);
			assert.equal(next.stopReason, "stop");
			assert.equal(server.connections, 2);
			assert.equal(server.requests[1]?.previous_response_id, undefined);
			assert.equal(sseRequests, 0);
		} finally {
			await server.close();
		}
	});
}

test("openai auto keeps retryable pre-start model errors on WebSocket", async () => {
	writeSettings({ openaiTransport: "auto" });
	let sseRequests = 0;
	const server = await startWebSocketServer([
		() => [{
			type: "error",
			status: 503,
			error: {
				type: "server_error",
				code: "service_unavailable",
				message: "transient model failure",
			},
		}],
		() => successEvents("resp_ws", "retried over websocket"),
	], (request, response) => {
		if (request.method !== "POST" || request.url !== "/v1/responses") {
			response.writeHead(404).end();
			return;
		}
		sseRequests++;
		response.writeHead(500).end();
	});
	try {
		const provider = createProviderHarness().openai;
		const failed = await runOpenAIProvider(provider, server.url, [{ role: "user", content: "hello" }], {
			maxRetries: 0,
		});
		const retried = await runOpenAIProvider(provider, server.url, [{ role: "user", content: "hello" }], {
			maxRetries: 0,
		});

		assert.equal(failed.stopReason, "error");
		assert.equal(failed.errorMessage, "HTTP 503: Codex error: transient model failure");
		assert.equal(retried.content[0]?.text, "retried over websocket");
		assert.equal(server.connections, 2);
		assert.equal(sseRequests, 0);
	} finally {
		await server.close();
	}
});

test("openai auto keeps retryable post-start failures on WebSocket for Pi's next agent retry", async () => {
	writeSettings({ openaiTransport: "auto" });
	let sseRequests = 0;
	const server = await startWebSocketServer([
		() => [{
			type: "response.created",
			response: { id: "resp_partial" },
		}, {
			type: "error",
			status: 503,
			error: {
				type: "server_error",
				code: "service_unavailable",
				message: "retry this request",
			},
		}],
		() => successEvents("resp_ws", "retried over websocket"),
	], (request, response) => {
		if (request.method !== "POST" || request.url !== "/v1/responses") {
			response.writeHead(404).end();
			return;
		}
		request.resume();
		request.on("end", () => {
			sseRequests++;
			response.writeHead(200, { "content-type": "text/event-stream" });
			for (const item of successEvents("resp_sse", "retried over sse")) {
				response.write(`data: ${JSON.stringify(item)}\n\n`);
			}
			response.end();
		});
	});
	try {
		const provider = createProviderHarness().openai;
		const failed = await runOpenAIProvider(provider, server.url, [{ role: "user", content: "hello" }]);
		const retried = await runOpenAIProvider(provider, server.url, [{ role: "user", content: "hello" }]);
		assert.equal(failed.stopReason, "error");
		assert.equal(retried.content[0]?.text, "retried over websocket");
		assert.equal(server.connections, 2);
		assert.equal(sseRequests, 0);
	} finally {
		await server.close();
	}
});

test("openai websocket-cached retries a missing previous response with full context", async () => {
	writeSettings({ openaiTransport: "websocket-cached" });
	const server = await startWebSocketServer([
		() => successEvents("resp_1", "first"),
		() => [{
			type: "error",
			status: 400,
			error: {
				type: "invalid_request_error",
				code: "previous_response_not_found",
				message: "Previous response was not found.",
			},
		}],
		() => successEvents("resp_2", "second"),
	]);
	try {
		const provider = createProviderHarness().openai;
		const first = await runOpenAIProvider(provider, server.url, [{ role: "user", content: "hello" }]);
		const second = await runOpenAIProvider(provider, server.url, [
			{ role: "user", content: "hello" },
			first,
			{ role: "user", content: "again" },
		]);
		assert.equal(second.stopReason, "stop");

		assert.equal(server.connections, 2);
		assert.equal(server.requests[1]?.previous_response_id, "resp_1");
		assert.equal(server.requests[2]?.previous_response_id, undefined);
		assert.equal(server.requests[2]?.input.length, 3);
	} finally {
		await server.close();
	}
});

test("openai auto does not fall back after transient WebSocket handshake failures", async () => {
	writeSettings({ openaiTransport: "auto" });
	let sseRequests = 0;
	const server = await startWebSocketServer([
		() => ({ handshakeStatus: 503, handshakeBody: { error: { message: "temporarily unavailable" } } }),
	], (request, response) => {
		if (request.method !== "POST" || request.url !== "/v1/responses") {
			response.writeHead(404).end();
			return;
		}
		request.resume();
		request.on("end", () => {
			sseRequests++;
			response.writeHead(500).end();
		});
	});
	try {
		const provider = createProviderHarness().openai;
		const first = await runOpenAIProvider(provider, server.url, [{ role: "user", content: "first" }], {
			maxRetries: 1,
			maxRetryDelayMs: 1_000,
		});
		const second = await runOpenAIProvider(provider, server.url, [{ role: "user", content: "second" }], {
			maxRetries: 1,
			maxRetryDelayMs: 1_000,
		});

		assert.equal(first.stopReason, "error");
		assert.equal(first.errorMessage, "HTTP 503: temporarily unavailable");
		assert.equal(second.stopReason, "error");
		assert.equal(second.errorMessage, "HTTP 503: temporarily unavailable");
		assert.equal(server.connections, 4);
		assert.equal(sseRequests, 0);
	} finally {
		await server.close();
	}
});

function useRetryClock(t: TestContext) {
	const delayMs = 120_000;
	const piBackoffMs = 25;
	const start = Date.parse("2026-01-01T00:00:00Z");
	let notifyScheduled!: () => void;
	const scheduled = new Promise<void>(resolve => { notifyScheduled = resolve; });
	const realSetTimeout = globalThis.setTimeout;
	const realClearTimeout = globalThis.clearTimeout;
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: start });
	const setTimeoutOnClock = globalThis.setTimeout;
	const clearTimeoutOnClock = globalThis.clearTimeout;
	const clockTimers = new Set<number | ReturnType<typeof setTimeout>>();
	// A fixture peer may not answer a close frame; keep ws's 30s fallback on the same clock.
	const timerSpy = t.mock.method(globalThis, "setTimeout", (callback: () => void, delay?: number, ...args: unknown[]) => {
		if (delay !== delayMs && delay !== piBackoffMs && delay !== 30_000) return realSetTimeout(callback, delay, ...args);
		const timer = setTimeoutOnClock(callback, delay, ...args);
		clockTimers.add(timer);
		if (delay === delayMs) notifyScheduled();
		return timer;
	});
	const clearSpy = t.mock.method(globalThis, "clearTimeout", (timer?: ReturnType<typeof setTimeout>) => {
		if (timer && clockTimers.delete(timer)) clearTimeoutOnClock(timer);
		else realClearTimeout(timer);
	});
	return { delayMs, piBackoffMs, start, scheduled, restore: () => {
		clearSpy.mock.restore();
		timerSpy.mock.restore();
		t.mock.timers.reset();
	} };
}

for (const phase of ["handshake", "first error event", "started response"] as const) {
	test(`ordinary WebSocket waits for Retry-After at ${phase} before handing retry to Pi`, { timeout: 3000 }, async t => {
		writeSettings({ openaiTransport: "auto" });
		const clock = useRetryClock(t);
		const controller = new AbortController();
		const signal = AbortSignal.any([controller.signal, t.signal]);
		let rejectHandshake = phase === "handshake";
		let httpRequests = 0;
		const server = await startWebSocketServer([
			(request) => {
				if (rejectHandshake) {
					rejectHandshake = false;
					return { handshakeStatus: 429, handshakeBody: { error: { message: "slow down" } }, handshakeHeaders: { "Retry-After": "120" } };
				}
				if (!request || phase === "handshake") return successEvents("resp_success", "retried by Pi");
				return phase === "first error event" ? [
					{ type: "error", status: 524, error: { message: "slow down", headers: { "Retry-After-Ms": 120_000, "Retry-After": "1" } } },
				] : [
					{ type: "response.created", response: { id: "resp_started" } },
					{ type: "response.failed", response: { error: { code: "server_is_overloaded", headers: { "retry-after": new Date(clock.start + clock.delayMs).toUTCString() } } } },
				];
			},
			() => successEvents("resp_success", "retried by Pi"),
		], (_request, response) => {
			httpRequests++;
			response.writeHead(400).end();
		});
		try {
			const provider = createProviderHarness().openai;
			const messages = [{ role: "user", content: "hello" }];
			type RetryNotice = { at: number; delay: number; message: string };
			let notifyPiRetry!: (notice: RetryNotice) => void;
			const piRetry = new Promise<RetryNotice>(resolve => { notifyPiRetry = resolve; });
			let attempts = 0;
			let retriesScheduled = 0;
			const result = retryAssistantCall(() => {
				attempts++;
				return runOpenAIProvider(provider, server.url, messages, {
					maxRetries: 2, maxRetryDelayMs: 60_000, signal, env: { NO_PROXY: "*" },
				});
			}, { enabled: true, maxRetries: 1, baseDelayMs: clock.piBackoffMs }, signal, {
				onRetryScheduled: (_attempt, _max, delay, message) => {
					retriesScheduled++;
					notifyPiRetry({ at: Date.now(), delay, message });
				},
			});
			await Promise.race([clock.scheduled, result.then(() => assert.fail("finished without the explicit wait"))]);
			assert.equal(websocketSessionCache.size, 0, "failed connection must be evicted before waiting");
			t.mock.timers.tick(clock.delayMs - 1);
			await new Promise(resolve => setImmediate(resolve));
			assert.equal(retriesScheduled, 0);
			assert.equal(attempts, 1);
			assert.equal(server.connections, 1);
			assert.equal(server.requests.length, phase === "handshake" ? 0 : 1);
			assert.equal(httpRequests, 0);
			t.mock.timers.tick(1);
			const retry = await Promise.race([piRetry, result.then(() => assert.fail("finished before Pi retried"))]);
			assert.equal(retry.at, clock.start + clock.delayMs);
			assert.equal(retry.delay, clock.piBackoffMs);
			assert.match(retry.message, phase === "started response"
				? /WebSocket error \(server_is_overloaded\): OpenAI Responses request failed/
				: /HTTP (429|524): .*slow down/);
			await new Promise(resolve => setImmediate(resolve));
			assert.equal(attempts, 1);
			t.mock.timers.tick(clock.piBackoffMs);
			assert.equal((await result).stopReason, "stop");
			assert.equal(retriesScheduled, 1);
			assert.equal(attempts, 2);
			assert.equal(server.connections, 2);
			assert.equal(server.requests.length, phase === "handshake" ? 1 : 2);
			assert.equal(server.requests.at(-1)?.previous_response_id, undefined);
			assert.equal(httpRequests, 0);
		} finally {
			controller.abort();
			closeProviderWebSocketSessions();
			clock.restore();
			await server.close();
		}
	});
}

test("cancelling WebSocket Retry-After aborts the turn without Pi retry", { timeout: 3000 }, async t => {
	writeSettings({ openaiTransport: "websocket" });
	const clock = useRetryClock(t);
	const controller = new AbortController();
	const server = await startWebSocketServer([() => [
		{ type: "error", status: 503, headers: { "Retry-After": "120" }, error: { message: "overloaded" } },
	]]);
	try {
		const result = runOpenAIProvider(createProviderHarness().openai, server.url, [{ role: "user", content: "hello" }], {
			maxRetries: 2, signal: controller.signal, env: { NO_PROXY: "*" },
		});
		await Promise.race([clock.scheduled, result.then(() => assert.fail("finished before the explicit wait"))]);
		assert.equal(websocketSessionCache.size, 0);
		t.mock.timers.tick(25);
		controller.abort();
		const message = await result;
		assert.equal(message.stopReason, "aborted");
		assert.equal(isRetryableAssistantError(message), false);
		assert.equal(server.requests.length, 1);
		assert.equal(server.connections, 1);
	} finally {
		controller.abort();
		clock.restore();
		await server.close();
	}
});

const overflowError = /Retry-After value exceeds the supported range/;
for (const [name, status, code, hint, expected] of [
	["insufficient quota", 429, "insufficient_quota", "120", /insufficient_quota.*slow down/],
	["subscription usage exhaustion", 429, "subscription_sharing_usage_limit_exceeded", "120", /subscription_sharing_usage_limit_exceeded.*slow down/],
	["authentication error", 401, "authentication_error", "120", /HTTP 401: .*slow down/],
	["unsafe seconds", 429, "rate_limit_exceeded", "1000000000000000000000000000000", overflowError],
	["numeric exponent overflow", 429, "rate_limit_exceeded", 1e30, overflowError],
	["decimal overflow", 429, "rate_limit_exceeded", "9".repeat(310), overflowError],
] as const) {
	test(`ordinary WebSocket neither waits nor resends ${name} with Retry-After`, { timeout: 3000 }, async t => {
		writeSettings({ openaiTransport: "websocket" });
		const clock = useRetryClock(t);
		const controller = new AbortController();
		const server = await startWebSocketServer([() => [
			{ type: "error", status, error: { code, message: "slow down", headers: { "Retry-After": hint } } },
		]]);
		try {
			const result = await Promise.race([
				runOpenAIProvider(createProviderHarness().openai, server.url, [{ role: "user", content: "hello" }], {
					maxRetries: 2, signal: controller.signal, env: { NO_PROXY: "*" },
				}),
				clock.scheduled.then(() => assert.fail("a permanent error must not wait")),
			]);
			assert.equal(result.stopReason, "error");
			assert.match(result.errorMessage, expected);
			assert.equal(isRetryableAssistantError(result), false);
			assert.equal(server.requests.length, 1);
			assert.equal(server.connections, 1);
		} finally {
			controller.abort();
			clock.restore();
			await server.close();
		}
	});
}

test("openai auto honors an explicit per-request SSE override", async () => {
	writeSettings({ openaiTransport: "auto" });
	let sseRequests = 0;
	const server = await startWebSocketServer([], (request, response) => {
		if (request.method !== "POST" || request.url !== "/v1/responses") {
			response.writeHead(404).end();
			return;
		}
		request.resume();
		request.on("end", () => {
			sseRequests++;
			response.writeHead(200, { "content-type": "text/event-stream" });
			for (const item of successEvents("resp_sse", "explicit sse")) {
				response.write(`data: ${JSON.stringify(item)}\n\n`);
			}
			response.end();
		});
	});
	try {
		const provider = createProviderHarness().openai;
		const result = await runOpenAIProvider(
			provider,
			server.url,
			[{ role: "user", content: "hello" }],
			{ transport: "sse" },
		);

		assert.equal(result.content[0]?.text, "explicit sse");
		assert.equal(server.connections, 0);
		assert.equal(sseRequests, 1);
	} finally {
		await server.close();
	}
});

test("openai auto switches immediately on HTTP 426 and remembers the fallback", async () => {
	writeSettings({ openaiTransport: "auto" });
	let sseRequests = 0;
	const server = await startWebSocketServer([
		() => ({ handshakeStatus: 426 }),
	], (request, response) => {
		if (request.method !== "POST" || request.url !== "/v1/responses") {
			response.writeHead(404).end();
			return;
		}
		request.resume();
		request.on("end", () => {
			sseRequests++;
			response.writeHead(200, { "content-type": "text/event-stream" });
			for (const item of successEvents(`resp_sse_${sseRequests}`, `sse ${sseRequests}`)) {
				response.write(`data: ${JSON.stringify(item)}\n\n`);
			}
			response.end();
		});
	});
	try {
		const provider = createProviderHarness().openai;
		await runOpenAIProvider(provider, server.url, [{ role: "user", content: "first" }]);
		await runOpenAIProvider(provider, server.url, [{ role: "user", content: "second" }]);
		assert.equal(server.connections, 1);
		assert.equal(sseRequests, 2);
	} finally {
		await server.close();
	}
});

test("openai auto falls back on an early 1009 only for the current request, replaying full context", async () => {
	writeSettings({ openaiTransport: "auto" });
	const httpRequests: Record<string, any>[] = [];
	const httpAuth: Array<string | undefined> = [];
	const server = await startWebSocketServer([
		() => successEvents("resp_ws_1", "first response"),
		() => [{ $close: 1009 }],
		() => successEvents("resp_ws_3", "third response"),
	], (request, response) => {
		httpAuth.push(request.headers.authorization);
		void (async () => {
			httpRequests.push(await readJsonRequest(request, response));
			for (const event of successEvents("resp_sse_2", "fallback response")) {
				response.write(`data: ${JSON.stringify(event)}\n\n`);
			}
			response.end();
		})();
	});
	try {
		const provider = createProviderHarness().openai;
		const first = { role: "user", content: "first prompt", timestamp: 1 };
		const second = { role: "user", content: "second prompt", timestamp: 2 };
		const firstResult = await runOpenAIProvider(provider, server.url, [first]);
		const result = await runOpenAIProvider(provider, server.url, [first, firstResult, second], { maxRetries: 1 });
		assert.equal(result.content[0]?.text, "fallback response");
		assert.ok(result.diagnostics?.some((diagnostic: { details?: { phase?: string } }) =>
			diagnostic.details?.phase === "websocket_message_too_large"));
		assert.equal(server.connections, 1, "do not open another WebSocket for the oversized request");
		assert.equal(server.requests.length, 2);
		assert.equal(server.requests[1]?.previous_response_id, "resp_ws_1");
		assert.equal(server.requests[1]?.input.length, 1);
		assert.equal(httpRequests.length, 1);
		assert.equal(httpRequests[0]?.previous_response_id, undefined);
		assert.deepEqual(httpRequests[0]?.input.map((item: { role: string }) => item.role), ["user", "assistant", "user"]);
		assert.equal(httpRequests[0]?.input[0]?.content[0]?.text, first.content);
		assert.equal(httpRequests[0]?.input[2]?.content[0]?.text, second.content);
		assert.deepEqual(httpAuth, ["Bearer pi-resolved-api-key"]);
		assert.equal(server.handshakes[0]?.headers.authorization, httpAuth[0]);

		const next = await runOpenAIProvider(provider, server.url, [{ role: "user", content: "third prompt" }]);
		assert.equal(next.content[0]?.text, "third response");
		assert.equal(server.connections, 2);
		assert.equal(server.requests[2]?.previous_response_id, undefined);
		assert.equal(httpRequests.length, 1);
	} finally {
		await server.close();
	}
});

for (const { name, transport, denySse, text } of [
	{ name: "forced websocket", transport: "websocket" },
	{ name: "forced websocket-cached", transport: "websocket-cached" },
	{ name: "auto with SSE denied", denySse: true },
	{ name: "auto after metadata", text: { type: "codex.response.metadata", headers: { "openai-model": "gpt-5.5" } } },
	{ name: "auto after malformed text", text: { $rawText: "not json" } },
	{ name: "auto after response.created", text: { type: "response.created", response: { id: "resp_partial" } } },
]) test(`openai ${name} does not retry or fall back on 1009`, async () => {
	let posts = 0;
	const server = await startWebSocketServer([
		() => [...(text ? [text] : []), { $close: 1009 }],
		() => successEvents("resp_unexpected", "unexpected retry"),
	], (_request, response) => {
		posts++;
		response.writeHead(400).end();
	});
	try {
		writeSettings({
			openaiTransport: "auto",
			...(denySse ? { endpoint_config: [{ provider: "openai", baseUrl: server.url, transport: ["websocket"] }] } : {}),
		});
		const provider = createProviderHarness().openai;
		const result = await runOpenAIProvider(provider, server.url, [{ role: "user", content: "hello" }], {
			transport, maxRetries: 1, maxRetryDelayMs: 5_500,
		});
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage, text
			? /after response text arrived \(close code 1009\)/
			: /request exceeds the peer's message size limit \(close code 1009\)/);
		assert.equal(isRetryableAssistantError(result), false);
		assert.equal(server.connections, 1);
		assert.equal(server.requests.length, 1);
		assert.equal(posts, 0);
	} finally {
		await server.close();
	}
});

test("openai auto keeps ordinary early WebSocket closes retryable without falling back", async () => {
	writeSettings({ openaiTransport: "auto" });
	let posts = 0;
	const server = await startWebSocketServer([
		() => [{ $close: 1001 }],
	], (_request, response) => {
		posts++;
		response.writeHead(400).end();
	});
	try {
		const result = await runOpenAIProvider(createProviderHarness().openai, server.url, [
			{ role: "user", content: "hello" },
		], { maxRetries: 0 });
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage, /WebSocket closed 1001/);
		assert.equal(isRetryableAssistantError(result), true);
		assert.equal(server.requests.length, 1);
		assert.equal(posts, 0);
	} finally {
		await server.close();
	}
});

test("openai websocket-cached uses exact server output items and ignores internal metadata", async () => {
	writeSettings({ openaiTransport: "websocket-cached" });
	const serverItem = {
		type: "message",
		id: "msg_server",
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text: "assistant output", annotations: [] }],
	};
	const server = await startWebSocketServer([
		() => [
			{ type: "response.created", response: { id: "resp_1" } },
			{ type: "response.output_item.added", output_index: 0, item: { ...serverItem, status: "in_progress", content: [] } },
			{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "assistant output" },
			{ type: "response.output_item.done", output_index: 0, item: serverItem },
			{
				type: "response.completed",
				response: {
					id: "resp_1",
					status: "completed",
					output: [serverItem],
					usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0 } },
				},
			},
		],
		() => successEvents("resp_2", "continued"),
	]);
	try {
		const provider = createProviderHarness().openai;
		const first = await runOpenAIProvider(provider, server.url, [{ role: "user", content: "hello" }]);
		const replayItem = JSON.parse(first.content[0]?.textSignature).item;
		replayItem.internal_chat_message_metadata_passthrough = { turn_id: "pi-turn" };
		first.content[0].textSignature = JSON.stringify({ v: 2, item: replayItem });
		const second = await runOpenAIProvider(provider, server.url, [
			{ role: "user", content: "hello" },
			first,
			{ role: "user", content: "again" },
		]);

		assert.equal(second.stopReason, "stop");
		assert.equal(server.requests[1]?.previous_response_id, "resp_1");
		assert.equal(server.requests[1]?.input.length, 1);
		assert.equal(server.requests[1]?.input[0]?.content[0]?.text, "again");
	} finally {
		await server.close();
	}
});

test("openai websocket strips unprefixed response item ids without mutating request context", async () => {
	writeSettings({ openaiTransport: "websocket" });
	const server = await startWebSocketServer([
		() => successEvents("resp_1", "ok"),
	]);
	const assistant = {
		role: "assistant",
		content: [{
			type: "text",
			text: "legacy",
			textSignature: JSON.stringify({
				v: 2,
				item: {
					type: "message",
					id: "legacy-id",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "legacy", annotations: [] }],
				},
			}),
		}],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5.5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	try {
		const provider = createProviderHarness().openai;
		await runOpenAIProvider(provider, server.url, [
			{ role: "user", content: "hello" },
			assistant,
			{ role: "user", content: "again" },
		]);
		assert.equal(server.requests[0]?.input[1]?.id, undefined);
		assert.equal(JSON.parse(assistant.content[0].textSignature).item.id, "legacy-id");
	} finally {
		await server.close();
	}
});

test("openai websocket ignores malformed text frames and completes", async () => {
	writeSettings({ openaiTransport: "websocket" });
	const server = await startWebSocketServer([
		() => [{ $rawText: "not json" }, ...successEvents("resp_1", "ok")],
	]);
	try {
		const provider = createProviderHarness().openai;
		const result = await runOpenAIProvider(provider, server.url, [{ role: "user", content: "hello" }]);
		assert.equal(result.stopReason, "stop");
		assert.equal(result.content[0]?.text, "ok");
	} finally {
		await server.close();
	}
});

test("openai websocket rejects binary response frames", async () => {
	writeSettings({ openaiTransport: "websocket" });
	const server = await startWebSocketServer([
		() => [{ $binary: "{\"type\":\"response.completed\"}" }],
	]);
	try {
		const provider = createProviderHarness().openai;
		const result = await runOpenAIProvider(provider, server.url, [{ role: "user", content: "hello" }]);
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage, /Unexpected binary OpenAI Responses WebSocket event/);
	} finally {
		await server.close();
	}
});

test("openai websocket serializes concurrent requests on one session connection", { timeout: 5_000 }, async (t) => {
	writeSettings({ openaiTransport: "websocket" });
	const checkpoints = new EventEmitter<{ firstReceived: [Duplex]; secondReady: [] }>();
	let releaseFirst!: () => void;
	const holdFirst = new Promise<void>((resolve) => { releaseFirst = resolve; });
	const server = await startWebSocketServer([
		() => ({
			before(_body, socket) {
				checkpoints.emit("firstReceived", socket);
				return holdFirst;
			},
			events: successEvents("resp_1", "first"),
		}),
		() => successEvents("resp_2", "second"),
	]);
	const abort = new AbortController();
	const signal = AbortSignal.any([abort.signal, t.signal, AbortSignal.timeout(4_000)]);
	const pending: Promise<unknown>[] = [];
	try {
		const provider = createProviderHarness().openai;
		const options = { signal, maxRetries: 0, env: { NO_PROXY: "*" } };
		const firstReceived = once(checkpoints, "firstReceived", { signal });
		const first = runOpenAIProvider(provider, server.url, [{ role: "user", content: "first" }], options);
		pending.push(first);
		const [socket] = await firstReceived;
		const secondReady = once(checkpoints, "secondReady", { signal });
		const second = runOpenAIProvider(provider, server.url, [{ role: "user", content: "second" }], {
			...options,
			transformHeaders(headers: Record<string, string>) {
				checkpoints.emit("secondReady");
				return headers;
			},
		});
		pending.push(second);
		await secondReady;
		// The pong travels behind any request already sent on this socket, without completing the first response.
		await server.ping(socket, signal);
		assert.equal(server.requests.length, 1, "second request reached the server before the first response completed");
		releaseFirst();
		const [firstResult, secondResult] = await Promise.all([first, second]);
		assert.equal(firstResult.content[0]?.text, "first");
		assert.equal(secondResult.content[0]?.text, "second");
		assert.equal(server.connections, 1);
		assert.equal(server.requests.length, 2);
	} finally {
		releaseFirst();
		abort.abort();
		await server.close();
		await Promise.allSettled(pending);
	}
});

for (const oversized of [false, true]) test(`startup WebSocket prewarm remains one-shot (1009=${oversized})`, async () => {
	writeSettings({ openaiTransport: oversized ? "auto" : "websocket", openaiWebSocketPrewarm: true });
	let httpRequests = 0;
	const server = await startWebSocketServer([
		() => oversized ? [{ $close: 1009 }] : successEvents("warm_1"),
		() => successEvents("resp_1", "first response"),
		() => successEvents("resp_2", "second response"),
	], (_request, response) => {
		httpRequests++;
		response.writeHead(400).end();
	});
	try {
		const harness = createProviderHarnessWithEvents();
		const model = {
			provider: "openai",
			api: "openai-responses",
			id: "gpt-5.5",
			baseUrl: server.url,
			headers: {},
			input: ["text"],
			reasoning: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		const ctx = providerEventContext(model);
		await emitHandlers(harness, "session_start", { type: "session_start", reason: "startup" }, ctx);
		await emitHandlers(harness, "before_agent_start", {
			type: "before_agent_start",
			prompt: "hello",
			systemPrompt: "",
		}, ctx);
		const first = await runOpenAIProvider(
			harness.providers.openai,
			server.url,
			[{ role: "user", content: "hello" }],
		);
		await emitHandlers(harness, "before_agent_start", {
			type: "before_agent_start",
			prompt: "again",
			systemPrompt: "",
		}, ctx);
		const second = await runOpenAIProvider(harness.providers.openai, server.url, [
			{ role: "user", content: "hello" },
			first,
			{ role: "user", content: "again" },
		]);

		assert.equal(first.content[0]?.text, "first response");
		assert.equal(second.content[0]?.text, "second response");
		assert.equal(server.connections, oversized ? 2 : 1);
		assert.equal(server.requests.length, 3);
		assert.equal(server.requests[0]?.generate, false);
		assert.deepEqual(server.requests[0]?.input, []);
		assert.equal(server.requests[1]?.previous_response_id, oversized ? undefined : "warm_1");
		assert.equal(server.requests[1]?.input[0]?.content[0]?.text, "hello");
		assert.equal(server.requests[2]?.previous_response_id, "resp_1");
		assert.equal(server.requests[2]?.input.length, 1);
		assert.equal(server.requests[2]?.input[0]?.content[0]?.text, "again");
		assert.equal(server.requests.filter((request) => request.generate === false).length, 1);
		assert.equal(httpRequests, 0);
	} finally {
		await server.close();
	}
});

test("resumed sessions prewarm once without replaying restored history", async () => {
	writeSettings({ openaiTransport: "websocket", openaiWebSocketPrewarm: true });
	const server = await startWebSocketServer([
		() => successEvents("warm_resume"),
		() => successEvents("resp_resume", "resumed response"),
	]);
	try {
		const harness = createProviderHarnessWithEvents();
		const model = {
			provider: "openai",
			api: "openai-responses",
			id: "gpt-5.5",
			baseUrl: server.url,
			headers: {},
			input: ["text"],
			reasoning: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		const ctx = providerEventContext(model, { systemPrompt: "stable system" });
		await emitHandlers(harness, "session_start", { type: "session_start", reason: "resume" }, ctx);
		await emitHandlers(harness, "before_agent_start", {
			type: "before_agent_start",
			prompt: "new message",
			systemPrompt: "stable system",
		}, ctx);
		const result = await harness.providers.openai.streamSimple(
			model,
			{
				systemPrompt: "stable system",
				messages: [
					{ role: "user", content: "restored user" },
					{
						role: "assistant",
						api: "openai-responses",
						provider: "openai",
						model: "gpt-5.5",
						content: [{ type: "text", text: "restored assistant" }],
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: 1,
					},
					{ role: "user", content: "new message" },
				],
				tools: [],
			},
			{ apiKey: "pi-resolved-api-key", sessionId: "pi-session" },
		).result();

		assert.equal(result.content[0]?.text, "resumed response");
		assert.equal(server.requests.length, 2);
		assert.equal(server.requests[0]?.generate, false);
		assert.equal(server.requests[0]?.input.length, 1);
		assert.equal(server.requests[0]?.input[0].role, "developer");
		assert.equal(server.requests[0]?.input[0].content[0].text, "stable system");
		assert.equal(server.requests[0]?.instructions, undefined);
		assert.equal(server.requests[1]?.previous_response_id, "warm_resume");
		assert.equal(server.requests[1]?.input.length, 3);
		assert.equal(server.requests.filter((request) => request.generate === false).length, 1);
	} finally {
		await server.close();
	}
});

test("max reasoning stays identical between startup prewarm and first request", async () => {
	writeSettings({ openaiTransport: "websocket", openaiWebSocketPrewarm: true });
	const server = await startWebSocketServer([
		() => successEvents("warm_max"),
		() => successEvents("resp_max", "ok"),
	]);
	try {
		const harness = createProviderHarnessWithEvents();
		const model = {
			provider: "openai",
			api: "openai-responses",
			id: "gpt-5.6-sol",
			baseUrl: server.url,
			headers: {},
			input: ["text"],
			reasoning: true,
			thinkingLevelMap: { max: "max" },
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		const ctx = providerEventContext(model, { thinkingLevel: "max" });
		await emitHandlers(harness, "session_start", { type: "session_start", reason: "startup" }, ctx);
		await harness.providers.openai.streamSimple(
			model,
			{
				systemPrompt: "",
				messages: [{ role: "user", content: "hello" }],
				tools: [],
			},
			{
				apiKey: "pi-resolved-api-key",
				sessionId: "pi-session",
				reasoning: "max",
			},
		).result();

		assert.equal(server.requests[0]?.reasoning?.effort, "max");
		assert.equal(server.requests[1]?.reasoning?.effort, "max");
		assert.equal(server.requests[1]?.previous_response_id, "warm_max");
	} finally {
		await server.close();
	}
});
