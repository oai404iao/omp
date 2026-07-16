import assert from "node:assert/strict";
import test from "node:test";
import { createApplyPatchToolDefinition } from "../src/tools/apply-patch.js";
import { createWebSearchToolDefinition } from "../src/tools/web-search.js";

test("apply_patch definition is compatible with pi-tool-renderer assumptions", () => {
	const tool = createApplyPatchToolDefinition({ deferRendering: true }) as Record<string, any>;
	assert.equal(tool.name, "apply_patch");
	assert.ok(tool.parameters.properties.input);
	assert.deepEqual(tool.parameters.required, ["input"]);
	assert.equal(tool.renderShell, "self");
	assert.equal("renderCall" in tool, false);
	assert.equal("renderResult" in tool, false);
});

test("fallback output remains readable without a custom renderer", async () => {
	const tool = createApplyPatchToolDefinition({ cwd: process.cwd(), deferRendering: true }) as Record<string, any>;
	assert.equal(typeof tool.execute, "function");
	assert.match(tool.description, /Codex-style patch/);
	assert.match(tool.promptSnippet, /input/);
});

test("web_search definition is a strict native-provider placeholder", async () => {
	const tool = createWebSearchToolDefinition() as Record<string, any>;
	assert.equal(tool.name, "web_search");
	assert.deepEqual(tool.parameters, { type: "object", additionalProperties: false, properties: {} });
	const result = await tool.execute();
	assert.match(result.content[0].text, /native-provider-first/);
	assert.equal(result.details.nativeTool, "web_search");
});
