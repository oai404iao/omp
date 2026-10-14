import assert from "node:assert/strict";
import { test } from "node:test";
import { activityText, responseActivity, resultPreview, toolActivity, toolResultActivity } from "../src/activity-preview.ts";
import { assistant } from "./support/fixture.ts";

test("semantic tool inputs include useful content, not unrelated fields", () => {
	const cases: [string, unknown, string][] = [
		["bash", { command: "pnpm check", secret: "HIDDEN" }, "$ pnpm check"],
		["powershell", { command: "Get-ChildItem", token: "HIDDEN" }, "PS> Get-ChildItem"],
		["write", { path: "src/a.ts", content: "export const a = 1;\n", secret: "HIDDEN" }, "export const a = 1;"],
		["edit", { path: "src/a.ts", edits: [{ oldText: "before", newText: "after" }], secret: "HIDDEN" }, "- before\n+ after"],
		["edit", { file_path: "src/a.ts", oldText: "old", newText: "new" }, "- old\n+ new"],
		["apply_patch", { input: "*** Begin Patch\n*** Update File: src/a.ts\n@@ function a\n-old\n+new\n*** End Patch" }, "-old\n+new"],
		["search", { query: "safe query", credentials: "HIDDEN" }, "safe query"],
	];
	for (const [name, args, expected] of cases) {
		const content = toolActivity(name, args);
		assert(content.preview?.includes(expected), `${name}: ${JSON.stringify(content)}`);
		assert(!JSON.stringify(content).includes("HIDDEN"));
	}
	assert.deepEqual(toolActivity("read", { path: "file.ts", command: "HIDDEN" }), { summary: "file.ts" });
	assert.deepEqual(toolActivity("unknown", { secret: "HIDDEN" }), { summary: "" });
	assert.match(toolActivity("edit", { path: "a", edits: [{ oldText: "a", newText: "b" }, {}] }).summary, /2 replacements/);
	assert.match(toolActivity("apply_patch", { input: "*** Delete File: old.ts" }).summary, /Delete File: old.ts/);
});

test("previews preserve readable lines, sanitize terminal instructions and bound Unicode output", () => {
	const hostile = "\x1b[31mhello\x1b[0m\n\x1b]8;;https://evil.test\x07link\x1b]8;;\x07\u202e\x00";
	assert.equal(activityText(hostile), "hello\nlink");
	assert.equal(activityText(hostile, 240, false), "hello link");
	const long = activityText("🙂".repeat(100_000));
	assert.equal(Array.from(long).length, 240);
	assert(long.endsWith("…"));
	assert.equal(activityText("abc", 0), "");
	assert.equal(toolActivity("write", { path: "file", content: "文".repeat(100_000) }).preview?.length, 240);
});

test("results show only text, prioritize failures and do not duplicate partial outputs", () => {
	const input = toolActivity("bash", { command: "pnpm check" });
	const result = { content: [{ type: "image", data: "HIDDEN" }, { type: "text", text: "All tests pass\nDone" }], secret: "HIDDEN" };
	assert.equal(resultPreview(result), "All tests pass\nDone");
	assert.equal(toolResultActivity(input, result).preview, "$ pnpm check\n› All tests pass\nDone");
	assert.equal(toolResultActivity(input, { content: [{ type: "text", text: "ERROR: failed" }] }, true).preview, "ERROR: failed");
	assert.equal(resultPreview({ content: [] }), "");
});

test("responses exclude thinking/signatures and provide tool-only and generation fallbacks", () => {
	const message = { ...assistant("visible\nanswer"), content: [
		{ type: "thinking" as const, thinking: "HIDDEN", thinkingSignature: "HIDDEN" },
		{ type: "text" as const, text: "visible\nanswer", textSignature: "HIDDEN" },
	] };
	assert.deepEqual(responseActivity(message), { summary: "visible answer", preview: "visible\nanswer" });
	assert.equal(responseActivity({ ...message, content: [{ type: "toolCall", id: "call", name: "bash", arguments: {} }] }).preview, "Requested bash");
	assert.equal(responseActivity({ ...message, content: [], stopReason: "pending" }).preview, "Generating response…");
	assert.equal(responseActivity({ ...message, content: [] }).preview, "No text response");
});
