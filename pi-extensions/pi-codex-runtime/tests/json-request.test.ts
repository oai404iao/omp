import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test, { type TestContext } from "node:test";
import { fetchCodexJson } from "../src/json-request.js";

function immediateRetries(t: TestContext): number[] {
	const delays: number[] = [];
	const original = globalThis.setTimeout;
	t.mock.method(globalThis, "setTimeout", ((callback: () => void, delay: number) => {
		delays.push(delay);
		return original(callback, 0);
	}) as typeof setTimeout);
	return delays;
}
const request = () => ({ headers: new Headers({ "x-codex-image-turn-id": "turn_fixture" }), body: '{"prompt":"fixture"}' });

test("JSON requests use Codex's four-retry 5xx budget and stable header/body snapshot", async t => {
	const delays = immediateRetries(t);
	t.mock.method(Math, "random", () => 0.5);
	const init = request();
	const captured: unknown[] = [];
	t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
		captured.push([options.method, options.body, new Headers(options.headers).get("x-codex-image-turn-id")]);
		init.headers.set("x-codex-image-turn-id", "changed_after_dispatch");
		return new Response("unavailable", { status: 503 });
	});
	const response = await fetchCodexJson("https://fixture.invalid/images/generations", init);
	assert.equal(response.status, 503);
	assert.equal(await response.text(), "unavailable");
	assert.equal(captured.length, 5);
	assert(captured.every(item => JSON.stringify(item) === '["POST","{\\"prompt\\":\\"fixture\\"}","turn_fixture"]'));
	assert.deepEqual(delays, [200, 400, 800, 1600]);
});

test("JSON retries honor Retry-After seconds and HTTP dates", async t => {
	const delays = immediateRetries(t);
	t.mock.method(Date, "now", () => Date.UTC(2026, 0, 1));
	let calls = 0;
	t.mock.method(globalThis, "fetch", async () => {
		calls++;
		return calls <= 2 ? new Response("retry", { status: 503, headers: {
			"Retry-After": calls === 1 ? "1" : "Thu, 01 Jan 2026 00:00:02 GMT",
		} }) : Response.json({ ok: true });
	});
	assert.equal((await fetchCodexJson("https://fixture.invalid/alpha/search", request())).status, 200);
	assert.deepEqual(delays, [1000, 2000]);
});

test("rate limits, permanent errors and explicit endpoint rejection are not retried", async t => {
	const delays = immediateRetries(t);
	for (const [status, body] of [
		[429, "rate limited"],
		[401, "unauthorized"],
		[501, '{"error":{"code":"unsupported_feature","message":"alpha/search is not supported"}}'],
	] as const) {
		let calls = 0;
		t.mock.method(globalThis, "fetch", async () => { calls++; return new Response(body, { status }); });
		const response = await fetchCodexJson("https://fixture.invalid/alpha/search", request(), ["webSearch.standalone"]);
		assert.equal(response.status, status);
		assert.equal(await response.text(), body);
		assert.equal(calls, 1);
	}
	assert.deepEqual(delays, []);
});

test("long Retry-After advice is surfaced without retrying early", async t => {
	let calls = 0;
	t.mock.method(globalThis, "fetch", async () => {
		calls++;
		return new Response("later", { status: 503, headers: { "Retry-After": "120" } });
	});
	assert.equal((await fetchCodexJson("https://fixture.invalid/alpha/search", request())).status, 503);
	assert.equal(calls, 1);
});

test("transport failures retry but abort and build failures do not", async t => {
	const delays = immediateRetries(t);
	let calls = 0;
	t.mock.method(globalThis, "fetch", async () => { calls++; throw new TypeError("fetch failed"); });
	await assert.rejects(fetchCodexJson("https://fixture.invalid/alpha/search", request()), /fetch failed/);
	assert.equal(calls, 5);
	assert.equal(delays.length, 4);
	calls = 0;
	t.mock.method(globalThis, "fetch", async () => { calls++; throw new TypeError("invalid request option"); });
	await assert.rejects(fetchCodexJson("https://fixture.invalid/alpha/search", request()), /invalid request option/);
	assert.equal(calls, 1);
	const controller = new AbortController();
	controller.abort(new Error("cancelled"));
	await assert.rejects(fetchCodexJson("https://fixture.invalid/alpha/search", { ...request(), signal: controller.signal }), /cancelled/);
	assert.equal(calls, 1);
});

test("aborting retry delay stops the next request and removes its abort listener", async t => {
	const controller = new AbortController();
	const original = globalThis.setTimeout;
	t.mock.method(globalThis, "setTimeout", (() => original(() => controller.abort(new Error("cancel retry")), 0)) as unknown as typeof setTimeout);
	let calls = 0;
	t.mock.method(globalThis, "fetch", async () => { calls++; return new Response("retry", { status: 503 }); });
	await assert.rejects(fetchCodexJson("https://fixture.invalid/alpha/search", { ...request(), signal: controller.signal }), /cancel retry/);
	assert.equal(calls, 1);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
