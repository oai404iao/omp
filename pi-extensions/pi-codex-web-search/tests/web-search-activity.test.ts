import assert from "node:assert/strict";
import test from "node:test";
import { buildWebSearchActivityMessage, extractWebSearch } from "@oai404iao/pi-codex-web-search/internal/tools/web-search/activity";

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
