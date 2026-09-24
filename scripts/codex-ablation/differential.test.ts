import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { zstdDecompressSync } from "node:zlib";
import { resetCodexWireState } from "@oai404iao/pi-codex-runtime/internal/codex-wire-identity";
import { context, denyFetch, frame, implementations, response, run, settle, start, terminal, textEvents, usage } from "./fixtures.js";

const originalFetch = globalThis.fetch;
beforeEach(() => { globalThis.fetch = denyFetch; });
afterEach(() => {
	globalThis.fetch = originalFetch;
	resetCodexWireState();
});

test("D0 positive control: text, Unicode, usage and terminal event agree", async () => {
	for (const implementation of implementations) {
		globalThis.fetch = async () => response();
		const { message, events } = await run(implementation);
		assert.equal(message.stopReason, "stop");
		assert.equal(message.content[0].type, "text");
		assert.equal((message.content[0] as any).text, "你好 🌍");
		assert.equal(message.usage.input, 70);
		assert.equal(message.usage.output, 10);
		assert.equal(message.usage.cacheRead, 30);
		assert.equal(message.usage.totalTokens, 110);
		assert.equal(events[0], "start");
		assert.equal(events.at(-1), "done");
	}
});

test("D1 regression: both implementations flush the residual SSE frame at EOF", async () => {
	for (const implementation of implementations) {
		globalThis.fetch = async () => new Response(textEvents().map(frame).join("").trimEnd());
		const { message } = await run(implementation);
		assert.equal(message.stopReason, "stop");
	}
});

test("D2 regression: both implementations fail closed on malformed SSE JSON", async () => {
	for (const implementation of implementations) {
		globalThis.fetch = async () => new Response(`data: {broken-json}\n\n${textEvents().map(frame).join("")}`);
		const { message } = await run(implementation);
		assert.equal(message.stopReason, "error");
		assert.match(message.errorMessage!, /Invalid Codex SSE JSON/);
	}
});

test("D3 regression: both implementations cancel a stalled body after headers", async () => {
	for (const implementation of implementations) {
		const abort = new AbortController();
		let bodyController!: ReadableStreamDefaultController<Uint8Array>;
		let cancelled = false;
		let finished = false;
		globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
			start(controller) {
				bodyController = controller;
				controller.enqueue(new TextEncoder().encode(frame(textEvents()[0])));
			},
			cancel() { cancelled = true; },
		}));
		const stream = start(implementation, { signal: abort.signal });
		const collected = (async () => {
			for await (const event of stream) {
				if (event.type === "start") {
					await settle();
					abort.abort();
				}
			}
			finished = true;
		})();
		try {
			// Both parsers have an outstanding reader.read(); no wall-clock benchmark.
			await settle();
			await settle();
			await settle();
			assert.equal(abort.signal.aborted, true);
			assert.equal(cancelled, true);
			assert.equal(finished, true);
		} finally {
			if (!cancelled) bodyController.close();
			await collected;
		}
		assert.equal((await stream.result()).stopReason, "aborted");
	}
});

test("D4 regression: both implementations honor injected fetch", async () => {
	for (const implementation of implementations) {
		let globalCalls = 0;
		let injectedCalls = 0;
		let responses = 0;
		globalThis.fetch = async () => { globalCalls++; return response(); };
		const { message } = await run(implementation, {
			fetch: async () => { injectedCalls++; return response(); },
			onResponse: () => { responses++; },
		});
		assert.equal(message.stopReason, "stop");
		assert.equal(responses, 1);
		assert.equal(injectedCalls, 1);
		assert.equal(globalCalls, 0);
	}
});

test("D5 regression: cacheRetention none removes the key in both implementations", async () => {
	for (const implementation of implementations) {
		let payload: any;
		globalThis.fetch = async () => response();
		await run(implementation, {
			sessionId: "offline-session", cacheRetention: "none",
			onPayload: (body: any) => { payload = structuredClone(body); },
		});
		assert.equal(payload.prompt_cache_key, undefined);
	}
});

test("D6 regression: both implementations account for cache writes separately", async () => {
	for (const implementation of implementations) {
		globalThis.fetch = async () => response([terminal({ usage: {
			...usage, input_tokens_details: { cached_tokens: 30, cache_write_tokens: 20 },
		} })]);
		const { message } = await run(implementation);
		assert.equal(message.usage.input, 50);
		assert.equal(message.usage.cacheWrite, 20);
		assert.equal(message.usage.cacheRead, 30);
		assert.equal(message.usage.totalTokens, 110);
	}
});

test("D7 regression: neither implementation produces negative fresh input", async () => {
	for (const implementation of implementations) {
		globalThis.fetch = async () => response([terminal({ usage: {
			...usage, input_tokens: 10, input_tokens_details: { cached_tokens: 30 },
		} })]);
		assert.equal((await run(implementation)).message.usage.input, 0);
	}
});

test("D8 regression: both distinguish filtering from output limits", async () => {
	for (const reason of ["content_filter", "max_output_tokens"]) {
		for (const implementation of implementations) {
			globalThis.fetch = async () => response([terminal({
				status: "incomplete", incomplete_details: { reason },
			})]);
			const { message, events } = await run(implementation);
			const error = reason === "content_filter";
			assert.equal(message.stopReason, error ? "error" : "length");
			assert.equal(events.at(-1), error ? "error" : "done");
			if (error) assert.match(message.errorMessage!, /content.filter/i);
		}
	}
});

test("D9 regression: both retain late encrypted reasoning content", async () => {
	const item = { type: "reasoning", id: "rs_fixture", summary: [{ type: "summary_text", text: "reason" }] };
	for (const implementation of implementations) {
		globalThis.fetch = async () => response([
			{ type: "response.output_item.added", output_index: 0, item: { ...item, summary: [] } },
			{ type: "response.output_item.done", output_index: 0, item },
			terminal({ output: [{ ...item, encrypted_content: "opaque-fixture" }] }),
		]);
		const { message } = await run(implementation);
		assert.equal(message.content[0].type, "thinking");
		const signature = JSON.parse((message.content[0] as any).thinkingSignature);
		assert.equal(signature.encrypted_content, "opaque-fixture");
	}
});

test("D10 onPayload replacement and onResponse work in both paths (positive control)", async () => {
	for (const implementation of implementations) {
		let received = false;
		globalThis.fetch = async (_url, init) => {
			assert.ok(init?.body);
			const json = new Headers(init.headers).get("content-encoding") === "zstd"
				? zstdDecompressSync(init.body as Uint8Array).toString()
				: String(init.body);
			assert.equal(JSON.parse(json).temperature, 0.25);
			return response();
		};
		const { message } = await run(implementation, {
			onPayload: (payload: any) => {
				assert.equal(payload.instructions, context.systemPrompt);
				return { ...payload, temperature: 0.25 };
			},
			onResponse: (metadata: any) => { received = metadata.status === 200; },
		});
		assert.equal(received, true);
		assert.equal(message.stopReason, "stop");
	}
});

test("D14 keep extension behavior: CRLF frames work where native rejects this fixture", async () => {
	for (const implementation of implementations) {
		globalThis.fetch = async () => new Response(textEvents().map(frame).join("").replaceAll("\n", "\r\n"));
		const { message } = await run(implementation);
		assert.equal(message.stopReason, implementation === "native" ? "error" : "stop");
		if (implementation === "native") assert.match(message.errorMessage!, /Invalid Codex SSE JSON/);
	}
});

test("D15 regression: cancelled terminal status emits an error, never done", async () => {
	for (const implementation of implementations) {
		globalThis.fetch = async () => response([terminal({ status: "cancelled" })]);
		const { message, events } = await run(implementation);
		assert.equal(message.stopReason, "error");
		assert.equal(events.at(-1), "error");
		assert.ok(message.errorMessage);
	}
});
