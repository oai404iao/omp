import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("apply_patch registers its filesystem preview renderer unless rendering is deferred", () => {
	const tool = createApplyPatchToolDefinition() as Record<string, any>;
	assert.equal(typeof tool.renderCall, "function");
	assert.equal(typeof tool.renderResult, "function");
});

test("apply_patch renderer updates from a throttled filesystem preview", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-apply-patch-render-"));
	writeFileSync(join(cwd, "existing.txt"), "before\n");
	const tool = createApplyPatchToolDefinition() as Record<string, any>;
	const theme = {
		fg(_color: string, text: string) { return text; },
		bg(_color: string, text: string) { return text; },
		bold(text: string) { return text; },
	};
	let resolvePreview: (() => void) | undefined;
	const previewReady = new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("preview timed out")), 2000);
		resolvePreview = () => {
			clearTimeout(timeout);
			resolve();
		};
	});
	const context: Record<string, any> = {
		state: {},
		lastComponent: undefined,
		cwd,
		argsComplete: false,
		expanded: false,
		isError: false,
		invalidate() { resolvePreview?.(); },
	};
	const args = { input: `*** Begin Patch
*** Update File: existing.txt
@@
-before
+after
` };
	const component = tool.renderCall(args, theme, context);
	await previewReady;
	context.lastComponent = component;
	const rendered = tool.renderCall(args, theme, context).render(120).join("\n");
	assert.match(rendered, /M existing\.txt/);
	assert.match(rendered, /1→1 lines/);
	const nextArgs = { input: `${args.input}+tail\n` };
	tool.renderCall(nextArgs, theme, context);
	assert.ok((component as any).previewTimer, "a newer partial preview is throttled");
	context.executionStarted = true;
	tool.renderCall(nextArgs, theme, context);
	assert.equal((component as any).previewTimer, undefined, "pending preview is cancelled before filesystem mutation");
	const result = {
		content: [{ type: "text", text: "Success. Updated the following files:\nM existing.txt" }],
		details: { files: [{ kind: "update", path: "existing.txt" }] },
	};
	assert.match(tool.renderResult(result, { expanded: false }, theme, context).render(120).join("\n"), /Applied/);
	const settled = component.render(120).join("\n");
	assert.match(settled, /apply_patch applied/);
	assert.match(settled, /M existing\.txt/);
	context.expanded = true;
	assert.match(tool.renderResult(result, { expanded: true }, theme, context).render(120).join("\n"), /M existing\.txt/);
});

test("fallback output remains readable without a custom renderer", async () => {
	const tool = createApplyPatchToolDefinition({ cwd: process.cwd(), deferRendering: true }) as Record<string, any>;
	assert.equal(typeof tool.execute, "function");
	assert.match(tool.description, /Codex patch format/);
	assert.doesNotMatch(tool.description, /input argument/i);
	assert.doesNotMatch(tool.promptSnippet, /input argument/i);
});

test("web_search definition exposes Codex commands and preserves hosted execution", async () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const agentDir = mkdtempSync(join(tmpdir(), "pi-web-search-renderer-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const tool = createWebSearchToolDefinition() as Record<string, any>;
		assert.equal(tool.name, "web_search");
		assert.equal(tool.parameters.type, "object");
		assert.equal(tool.parameters.additionalProperties, false);
		assert.ok(tool.parameters.properties.search_query);
		assert.ok(tool.parameters.properties.image_query);
		assert.ok(tool.parameters.properties.open);
		assert.equal(typeof tool.renderCall, "function");
		assert.equal(typeof tool.renderResult, "function");
		const theme = {
			fg(_color: string, text: string) { return text; },
			bold(text: string) { return text; },
		};
		const call = tool.renderCall(
			{ search_query: [{ q: "codex tools" }] },
			theme,
			{ cwd: process.cwd() },
		).render(120).join("\n");
		assert.match(call, /Web Search codex tools/);
		const rendered = tool.renderResult({
			content: [{ type: "text", text: "raw search payload" }],
			details: {
				mode: "standalone",
				results: [
					{ domain: "www.github.com", url: "https://github.com/openai/codex" },
					{ url: "https://openai.com/codex" },
					{ domain: "github.com", url: "https://github.com/openai" },
				],
			},
		}, { expanded: false }, theme, { cwd: process.cwd(), isError: false }).render(120).join("\n");
		assert.match(rendered, /\(3\)/);
		assert.match(rendered, /github\.com/);
		assert.match(rendered, /openai\.com/);
		assert.doesNotMatch(rendered, /raw search payload/);
		const expanded = tool.renderResult({
			content: [{ type: "text", text: "raw search payload" }],
			details: { mode: "standalone", results: [] },
		}, { expanded: true }, theme, { cwd: process.cwd(), isError: false }).render(120).join("\n");
		assert.match(expanded, /raw search payload/);
		const result = await tool.execute("", {}, undefined, undefined, {
			cwd: process.cwd(),
			model: {
				provider: "openai",
				api: "openai-responses",
				id: "gpt-5.5",
				input: ["text"],
			},
		});
		assert.match(result.content[0].text, /hosted-provider-first/);
		assert.equal(result.details.nativeTool, "web_search");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	}
});
