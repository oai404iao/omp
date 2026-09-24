import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach, type TestContext } from "node:test";
import { SSE_RESPONSE_HEADER_TIMEOUT_MS } from "@oai404iao/pi-codex-core/internal/providers/openai-codex/constants";
import { retryAfterMsFromHeaders, sleep, sseMaxRetries, sseRetryDelayMs } from "@oai404iao/pi-codex-core/internal/providers/openai-codex/retry";
import { codexJwt, createProviderHarness } from "./support/openai-codex-test-support.js";
import { createCodexChildIdentity, createCodexRootIdentity, registerCodexThreadIdentity, resetCodexWireState } from "../src/codex-wire-identity.js";
import { zstdDecompressSync } from "node:zlib";
import { requestCodexCompactionTrigger } from "@oai404iao/pi-codex-core/internal/adapter/compaction/http";

const originalFetch = globalThis.fetch;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
beforeEach(() => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-codex-sse-contract-"));
	const configDir = join(agentDir, "extensions", "pi-codex-minimal-tools");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(configDir, "config.json"), JSON.stringify({ openaiTransport: "sse" }));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	globalThis.fetch = async () => { throw new Error("Unexpected fetch in offline test"); };
});
afterEach(() => {
	resetCodexWireState();
	globalThis.fetch = originalFetch;
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

function completion(overrides: Record<string, unknown> = {}, type = "response.completed"): string {
	return `data: ${JSON.stringify({
		type, response: {
			id: "resp_fixture", status: "completed", output: [],
			usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }, ...overrides,
		},
	})}\n\n`;
}

function start(options: Record<string, unknown> = {}, modelOverrides: Record<string, unknown> = {}) {
	return createProviderHarness().providers["openai-codex"].streamSimple({
		provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.5",
		baseUrl: "https://example.invalid/backend-api", headers: {}, input: ["text"], reasoning: false,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...modelOverrides,
	}, {
		systemPrompt: "", messages: [{ role: "user", content: "hello", timestamp: 1 }], tools: [],
	}, { apiKey: codexJwt(), transport: "sse", ...options });
}

async function run(options: Record<string, unknown> = {}, modelOverrides: Record<string, unknown> = {}) {
	const stream = start(options, modelOverrides);
	const events: string[] = [];
	for await (const event of stream) events.push(event.type);
	assert.equal(events.filter((type) => type === "done" || type === "error").length, 1);
	return { message: await stream.result(), events };
}

function stubRetrySleep(t: TestContext): number[] {
	const delays: number[] = [];
	t.mock.method(globalThis, "setTimeout", ((callback: () => void, delay: number) => {
		if (delay !== SSE_RESPONSE_HEADER_TIMEOUT_MS) {
			delays.push(delay);
			queueMicrotask(callback);
		}
		return 0 as any;
	}) as typeof setTimeout);
	return delays;
}

test("SSE terminal EOF without blank line succeeds, missing terminal fails", async () => {
	globalThis.fetch = async () => new Response(completion().trimEnd());
	assert.equal((await run()).message.stopReason, "stop");
	globalThis.fetch = async () => new Response('data: {"type":"response.created","response":{"id":"r"}}\n\n');
	const { message, events } = await run();
	assert.equal(message.stopReason, "error");
	assert.equal(events.at(-1), "error");
	assert.match(message.errorMessage, /before response.completed/);
});

test("SSE provider cancels a stalled response without waiting for EOF", { timeout: 1000 }, async () => {
	const abort = new AbortController();
	let pulled!: () => void;
	const reading = new Promise<void>((resolve) => { pulled = resolve; });
	let cancelled = false;
	globalThis.fetch = async () => new Response(new ReadableStream({
		pull() { pulled(); },
		cancel() { cancelled = true; },
	}, { highWaterMark: 0 }));
	const result = run({ signal: abort.signal });
	await reading;
	abort.abort();
	const { message, events } = await result;
	assert.equal(cancelled, true);
	assert.equal(message.stopReason, "aborted");
	assert.deepEqual(events, ["start", "error"]);
});

test("SSE abort before start performs no HTTP request", async () => {
	const abort = new AbortController();
	abort.abort();
	let requests = 0;
	globalThis.fetch = async () => { requests++; return new Response(completion()); };
	const { message, events } = await run({ signal: abort.signal });
	assert.equal(requests, 0);
	assert.equal(message.stopReason, "aborted");
	assert.deepEqual(events, ["error"]);
});

test("SSE distinguishes incomplete reasons and never emits done for error terminals", async () => {
	for (const type of ["response.completed", "response.incomplete", "response.done"]) {
		for (const reason of ["max_output_tokens", "content_filter", "unknown_future_reason", undefined]) {
			globalThis.fetch = async () => new Response(completion({
				status: "incomplete", ...(reason ? { incomplete_details: { reason } } : {}),
			}, type));
			const { message, events } = await run();
			const limited = reason === "max_output_tokens";
			assert.equal(message.stopReason, limited ? "length" : "error");
			assert.equal(events.at(-1), limited ? "done" : "error");
			assert.equal(message.rawStopReason, reason ? `incomplete.${reason}` : "incomplete");
			if (!limited) assert.match(message.errorMessage, /incomplete/);
		}
	}
	for (const status of ["cancelled", "failed", "queued", "in_progress"]) {
		globalThis.fetch = async () => new Response(completion({ status }));
		const { message, events } = await run();
		assert.equal(message.stopReason, "error");
		assert.equal(message.rawStopReason, status);
		assert.ok(message.errorMessage);
		assert.equal(events.at(-1), "error");
	}
});

test("SSE preserves default three retries and honors explicit zero/one", async (t) => {
	const delays = stubRetrySleep(t);
	for (const [maxRetries, expected] of [[undefined, 4], [0, 1], [1, 2]] as const) {
		let calls = 0;
		delays.length = 0;
		globalThis.fetch = async () => { calls++; return new Response("Unavailable", { status: 503 }); };
		assert.equal((await run({ maxRetries })).message.stopReason, "error");
		assert.equal(calls, expected);
		assert.deepEqual(delays, [1000, 2000, 4000].slice(0, expected - 1));
	}
});

test("SSE honors Retry-After seconds and millisecond precedence", async (t) => {
	const delays = stubRetrySleep(t);
	for (const [headers, expected] of [
		[{ "retry-after": "0.125" }, 125],
		[{ "retry-after": "20", "retry-after-ms": "25" }, 25],
	] as const) {
		delays.length = 0;
		let calls = 0;
		globalThis.fetch = async () => ++calls === 1
			? new Response("Rate limited", { status: 429, headers })
			: new Response(completion());
		assert.equal((await run({ maxRetries: 1, maxRetryDelayMs: 500 })).message.stopReason, "stop");
		assert.equal(calls, 2);
		assert.deepEqual(delays, [expected]);
	}
});

test("SSE wait budget rejects server and fallback delays without extra attempts", async (t) => {
	const delays = stubRetrySleep(t);
	for (const factory of [
		() => new Response("Rate limited", { status: 429, headers: { "retry-after": "30" } }),
		() => new Response("Unavailable", { status: 503 }),
		() => { throw new Error("fetch failed"); },
	]) {
		let calls = 0;
		globalThis.fetch = async () => { calls++; return factory(); };
		const { message } = await run({ maxRetries: 1, maxRetryDelayMs: 500 });
		assert.equal(calls, 1);
		assert.match(message.errorMessage, /exceeds maxRetryDelayMs/);
		assert.deepEqual(delays, []);
	}
});

test("SSE does not retry HTTP 400 and explicit zero also applies to quota errors", async (t) => {
	const delays = stubRetrySleep(t);
	for (const [status, maxRetries, error] of [
		[400, 2, { message: "Invalid parameter" }],
		[429, 0, { code: "usage_limit_reached", message: "Quota exhausted" }],
	] as const) {
		let calls = 0;
		globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ error }), { status }); };
		assert.equal((await run({ maxRetries })).message.stopReason, "error");
		assert.equal(calls, 1);
		assert.deepEqual(delays, []);
	}
});

test("SSE abort during retry sleep prevents the next request", { timeout: 1000 }, async (t) => {
	const abort = new AbortController();
	let calls = 0;
	globalThis.fetch = async () => { calls++; return new Response("Unavailable", { status: 503 }); };
	const setTimeout = globalThis.setTimeout;
	t.mock.method(globalThis, "setTimeout", ((callback: () => void, delay: number) => {
		const timer = setTimeout(callback, delay);
		if (delay === 1000) queueMicrotask(() => abort.abort());
		return timer;
	}) as typeof globalThis.setTimeout);
	const { message, events } = await run({ maxRetries: 2, signal: abort.signal });
	assert.equal(message.stopReason, "aborted");
	assert.equal(events.at(-1), "error");
	assert.equal(calls, 1);
	assert.equal(getEventListeners(abort.signal, "abort").length, 0);
});

test("retry helpers parse dates, validate options and release settled sleep listeners", async (t) => {
	t.mock.method(Date, "now", () => Date.parse("2026-01-01T00:00:00Z"));
	assert.equal(retryAfterMsFromHeaders({ "Retry-After": "Thu, 01 Jan 2026 00:00:02 GMT" }), 2000);
	assert.equal(retryAfterMsFromHeaders({ "retry-after-ms": "invalid", "retry-after": "2" }), 2000);
	assert.equal(retryAfterMsFromHeaders({ "retry-after": "invalid" }), undefined);
	assert.equal(sseMaxRetries(undefined), 3);
	assert.equal(sseMaxRetries({ maxRetries: -1 }), 3);
	assert.equal(sseMaxRetries({ maxRetries: Number.NaN }), 3);
	assert.equal(sseMaxRetries({ maxRetries: 1.9 }), 1);
	assert.equal(sseRetryDelayMs(0, { maxRetryDelayMs: 0 }, { "retry-after": "120" }), 120000);
	assert.throws(() => sseRetryDelayMs(0, undefined, { "retry-after": "120" }), /exceeds maxRetryDelayMs/);
	const abort = new AbortController();
	await sleep(1, abort.signal);
	assert.equal(getEventListeners(abort.signal, "abort").length, 0);
	abort.abort();
	await assert.rejects(sleep(1, abort.signal), /Request was aborted/);
});

test("injected fetch owns networking and cache disabling preserves child wire identity", async () => {
	const parent = createCodexRootIdentity("parent-session");
	const child = registerCodexThreadIdentity(createCodexChildIdentity("child-session", parent, { relation: "spawn" }));
	let calls = 0;
	const result = await run({
		sessionId: child.piSessionId, cacheRetention: "none",
		env: { HTTPS_PROXY: "http://never-connect.invalid:8000" },
		fetch: async (_url: unknown, init: RequestInit) => {
			calls++;
			assert.equal("dispatcher" in init, false);
			const headers = new Headers(init.headers);
			assert.equal(headers.get("session-id"), child.sessionId);
			assert.equal(headers.get("thread-id"), child.threadId);
			assert.equal(headers.get("x-codex-parent-thread-id"), parent.threadId);
			assert.ok(headers.get("x-openai-subagent"));
			const body = JSON.parse(String(init.body));
			assert.equal(body.prompt_cache_key, undefined);
			assert.equal(body.client_metadata.session_id, child.sessionId);
			return new Response(completion());
		},
	});
	assert.equal(calls, 1);
	assert.equal(result.message.stopReason, "stop");
});

test("zstd is used only for the known Codex SSE endpoint, not custom endpoints", async () => {
	for (const baseUrl of ["https://chatgpt.com/backend-api", "https://custom.invalid/backend-api"]) {
		let calls = 0;
		const result = await run({
			fetch: async (_url: unknown, init: RequestInit) => {
				calls++;
				const encoded = new Headers(init.headers).get("content-encoding");
				assert.equal(encoded, baseUrl.includes("chatgpt.com") ? "zstd" : null);
				const body = encoded ? zstdDecompressSync(init.body as Uint8Array).toString() : String(init.body);
				assert.equal(JSON.parse(body).model, "gpt-5.5");
				return new Response(completion());
			},
		}, { baseUrl });
		assert.equal(calls, 1);
		assert.equal(result.message.stopReason, "stop");
	}
});

test("SSE rejects malformed JSON without retrying the response", async () => {
	let calls = 0;
	globalThis.fetch = async () => { calls++; return new Response(`data: {broken}\n\n${completion()}`); };
	const result = await run({ maxRetries: 3 });
	assert.equal(calls, 1);
	assert.equal(result.events.at(-1), "error");
	assert.match(result.message.errorMessage, /Invalid Codex SSE JSON/);
});

test("hard quota errors stop immediately while ordinary rate limits can retry", async (t) => {
	const delays = stubRetrySleep(t);
	for (const code of ["usage_limit_reached", "usage_not_included", "insufficient_quota", "billing_hard_limit_reached", "quota_exceeded", "rate_limit_exceeded"]) {
		let calls = 0;
		delays.length = 0;
		globalThis.fetch = async () => ++calls === 1
			? new Response(JSON.stringify({ error: { code, message: code } }), { status: 429 })
			: new Response(completion());
		const result = await run({ maxRetries: 1 });
		const transient = code === "rate_limit_exceeded";
		assert.equal(calls, transient ? 2 : 1);
		assert.equal(result.message.stopReason, transient ? "stop" : "error");
		assert.deepEqual(delays, transient ? [1000] : []);
	}
});

test("streaming compaction never retries terminal quota or malformed SSE events", async (t) => {
	const delays = stubRetrySleep(t);
	for (const frame of [
		`data: ${JSON.stringify({ type: "error", error: { code: "insufficient_quota", message: "Quota exhausted" } })}\n\n`,
		"data: {broken}\n\n",
	]) {
		let calls = 0;
		globalThis.fetch = async () => { calls++; return new Response(frame); };
		await assert.rejects(requestCodexCompactionTrigger(
			"https://example.invalid/responses", new Headers(), { input: [] } as any, undefined,
		), /Quota exhausted|Invalid Codex SSE JSON/);
		assert.equal(calls, 1);
		assert.deepEqual(delays, []);
	}
});
