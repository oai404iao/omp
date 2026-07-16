import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { buildWebSearchActivityMessage, extractWebSearch, fetchWithResponseHeaderTimeout, responseHeaderTimeoutMsFromOptions } from "../src/provider-shim.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

test("responseHeaderTimeoutMsFromOptions uses Pi HTTP timeout when provided", () => {
	assert.equal(responseHeaderTimeoutMsFromOptions({ timeoutMs: 45_000 } as any), 45_000);
	assert.equal(responseHeaderTimeoutMsFromOptions({ timeoutMs: 0 } as any), 20_000);
	assert.equal(responseHeaderTimeoutMsFromOptions(undefined), 20_000);
});

test("extractWebSearch surfaces call details and deduped sources", () => {
	const search = extractWebSearch({
		type: "web_search_call",
		id: "ws_123",
		status: "completed",
		action: {
			query: "latest docs",
			sources: [{ title: "Docs", url: "https://example.com/docs" }],
			results: [{ title: "Blog", url: "https://example.com/blog" }],
		},
		results: [{ title: "Docs duplicate", url: "https://example.com/docs" }, { title: "Guide", url: "https://example.com/guide" }],
	} as any);

	assert.deepEqual(search, {
		callId: "ws_123",
		status: "completed",
		query: "latest docs",
		queries: [],
		sources: [
			{ title: "Docs", url: "https://example.com/docs" },
			{ title: "Blog", url: "https://example.com/blog" },
			{ title: "Guide", url: "https://example.com/guide" },
		],
	});
	assert.match(buildWebSearchActivityMessage([search!]), /Call: ws_123 \(completed\)/);
	assert.match(buildWebSearchActivityMessage([search!]), /Docs: https:\/\/example\.com\/docs/);
});

test("fetchWithResponseHeaderTimeout aborts when SSE response headers stall", async () => {
	globalThis.fetch = ((_url: RequestInfo | URL, init?: RequestInit) =>
		new Promise<Response>((_resolve, reject) => {
			const signal = init?.signal;
			if (signal?.aborted) {
				reject(new Error("aborted before fetch"));
				return;
			}
			signal?.addEventListener("abort", () => reject(new Error("aborted by test")), { once: true });
		})) as typeof fetch;

	await assert.rejects(
		() => fetchWithResponseHeaderTimeout("https://example.test/backend-api/codex/responses", { method: "POST" }, undefined, 1),
		/Codex Responses SSE response headers timed out after 1ms/,
	);
});
