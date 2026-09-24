import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { SSE_RESPONSE_HEADER_TIMEOUT_MS } from "@oai404iao/pi-codex-core/internal/providers/openai-codex/constants";
import { denyFetch, implementations, run } from "./fixtures.js";

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
let delays: number[];
beforeEach(() => {
	delays = [];
	globalThis.fetch = denyFetch;
	// Extension maps timeoutMs:0 back to its header deadline. Keep that timer
	// dormant: immediate mocked headers cancel it; only retry sleeps advance.
	globalThis.setTimeout = ((callback: (...args: any[]) => void, delay: number, ...args: any[]) => {
		if (delay === SSE_RESPONSE_HEADER_TIMEOUT_MS) return 0 as any;
		delays.push(delay);
		queueMicrotask(() => callback(...args));
		return 0 as any;
	}) as typeof setTimeout;
});
afterEach(() => {
	globalThis.fetch = originalFetch;
	globalThis.setTimeout = originalSetTimeout;
});

test("D11 regression: maxRetries zero on HTTP 503 makes one request", async (t) => {
	for (const implementation of implementations) {
		let calls = 0;
		delays = [];
		globalThis.fetch = async () => { calls++; return new Response("Unavailable", { status: 503 }); };
		const { message } = await run(implementation, { maxRetries: 0 });
		assert.equal(message.stopReason, "error");
		assert.equal(calls, 1);
		assert.deepEqual(delays, []);
		t.diagnostic(`${implementation}: requests=${calls}, scheduled retry delays=${JSON.stringify(delays)}ms (retry-sleep stub)`);
	}
});

test("D12 regression: Retry-After exceeding the budget stops both implementations", async (t) => {
	for (const implementation of implementations) {
		let calls = 0;
		delays = [];
		globalThis.fetch = async () => {
			calls++;
			return new Response("Rate limited", { status: 429, headers: { "retry-after": "30" } });
		};
		const { message } = await run(implementation, { maxRetries: 1, maxRetryDelayMs: 5000 });
		assert.equal(message.stopReason, "error");
		assert.equal(calls, 1);
		assert.deepEqual(delays, []);
		if (implementation === "native") assert.match(message.errorMessage!, /30s retry delay/);
		else assert.match(message.errorMessage!, /30000ms exceeds maxRetryDelayMs 5000ms/);
		t.diagnostic(`${implementation}: requests=${calls}, scheduled retry delays=${JSON.stringify(delays)}ms (retry-sleep stub)`);
	}
});

test("D13 do not copy blindly: extension avoids native's configured HTTP 400 reattempt", async () => {
	for (const implementation of implementations) {
		let calls = 0;
		globalThis.fetch = async () => {
			calls++;
			return new Response(JSON.stringify({ error: { message: "Invalid fixture parameter" } }), { status: 400 });
		};
		const { message } = await run(implementation, { maxRetries: 1 });
		assert.equal(message.stopReason, "error");
		assert.equal(calls, implementation === "native" ? 2 : 1);
	}
});
