import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { parseSSE, fetchWithResponseHeaderTimeout } from "@oai404iao/pi-codex-core/internal/providers/openai-codex/sse";
import { collectCodexCompactionOutput } from "@oai404iao/pi-codex-core/internal/adapter/compaction/collect";

function bytewiseResponse(text: string): Response {
	const bytes = new TextEncoder().encode(text);
	return new Response(new ReadableStream({
		start(controller) {
			for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
			controller.close();
		},
	}));
}

async function collect(response: Response, signal?: AbortSignal): Promise<unknown[]> {
	const events: unknown[] = [];
	for await (const event of parseSSE(response, signal)) events.push(event);
	return events;
}

for (const newline of ["\n", "\r\n", "\r"]) {
	test(`SSE preserves multiline JSON and Unicode across byte boundaries (${JSON.stringify(newline)})`, async () => {
		const response = bytewiseResponse([
			": heartbeat",
			'data: {"type":"fixture",',
			'data: "text":"你好 🌍"}',
			"",
			'data: {"type":"last"}',
		].join(newline));
		assert.deepEqual(await collect(response), [{ type: "fixture", text: "你好 🌍" }, { type: "last" }]);
		assert.equal(response.body?.locked, false);
	});
}

test("SSE flushes an EOF frame ending in CR and ignores empty/DONE frames", async () => {
	assert.deepEqual(await collect(bytewiseResponse(
		'\ndata: [DONE]\n\ndata: {"type":"last"}\r',
	)), [{ type: "last" }]);
});

test("SSE fails closed on malformed JSON and releases the reader", async () => {
	const response = bytewiseResponse('data: {broken}\n\ndata: {"type":"last"}\n\n');
	await assert.rejects(collect(response), /Invalid Codex SSE JSON/);
	assert.equal(response.body?.locked, false);
});
test("SSE dispatches a CR-delimited terminal frame without waiting for EOF", { timeout: 1000 }, async (t) => {
	let cancelled = false;
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const event = { type: "response.completed", response: { id: "resp_cr", status: "completed" } };
	const response = new Response(new ReadableStream<Uint8Array>({
		start(value) {
			controller = value;
			controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\r\r`));
		},
		cancel() { cancelled = true; },
	}));
	t.after(() => { if (!cancelled) controller.close(); });
	const iterator = parseSSE(response)[Symbol.asyncIterator]();
	assert.deepEqual(await iterator.next(), { done: false, value: event });
	await iterator.return?.();
	assert.equal(cancelled, true);
});

test("SSE abort interrupts an outstanding reader and removes its listener", { timeout: 1000 }, async () => {
	const abort = new AbortController();
	let pulled!: () => void;
	const reading = new Promise<void>((resolve) => { pulled = resolve; });
	let cancelled = false;
	const response = new Response(new ReadableStream({
		pull() { pulled(); },
		cancel() { cancelled = true; },
	}, { highWaterMark: 0 }));
	const result = collect(response, abort.signal);
	const rejected = assert.rejects(result, /Request was aborted/);
	await reading;
	abort.abort();
	await rejected;
	assert.equal(cancelled, true);
	assert.equal(response.body?.locked, false);
	assert.equal(getEventListeners(abort.signal, "abort").length, 0);
});

test("SSE handles already-aborted signals and abort between buffered frames", async () => {
	const early = new AbortController();
	early.abort();
	await assert.rejects(collect(bytewiseResponse('data: {"type":"first"}\n\n'), early.signal), /Request was aborted/);

	const abort = new AbortController();
	const response = bytewiseResponse('data: {"type":"first"}\n\ndata: {"type":"second"}\n\n');
	const iterator = parseSSE(response, abort.signal)[Symbol.asyncIterator]();
	assert.equal((await iterator.next()).value.type, "first");
	abort.abort();
	await assert.rejects(iterator.next(), /Request was aborted/);
	assert.equal(response.body?.locked, false);
	assert.equal(getEventListeners(abort.signal, "abort").length, 0);
});

test("SSE early consumer return releases the reader and abort subscription", async () => {
	const abort = new AbortController();
	const response = bytewiseResponse('data: {"type":"first"}\n\n');
	for await (const _event of parseSSE(response, abort.signal)) break;
	assert.equal(response.body?.locked, false);
	assert.equal(getEventListeners(abort.signal, "abort").length, 0);
});

test("header timeout helper keeps the fetch body signal linked to caller cancellation", async (t) => {
	const abort = new AbortController();
	let fetchSignal: AbortSignal | undefined;
	t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
		fetchSignal = init.signal ?? undefined;
		return new Response("", { status: 503 });
	});
	await fetchWithResponseHeaderTimeout("https://example.invalid", {}, abort.signal);
	assert.equal(fetchSignal?.aborted, false);
	abort.abort();
	assert.equal(fetchSignal?.aborted, true);
});

test("compaction SSE collection also cancels stalled body reads", { timeout: 1000 }, async () => {
	const abort = new AbortController();
	let pulled!: () => void;
	const reading = new Promise<void>((resolve) => { pulled = resolve; });
	let cancelled = false;
	const response = new Response(new ReadableStream({
		pull() { pulled(); },
		cancel() { cancelled = true; },
	}, { highWaterMark: 0 }));
	const rejected = assert.rejects(collectCodexCompactionOutput(response, undefined, abort.signal), /Request was aborted/);
	await reading;
	abort.abort();
	await rejected;
	assert.equal(cancelled, true);
});
