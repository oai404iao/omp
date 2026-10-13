import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApplyPatchToolDefinition } from "@oai404iao/pi-codex-core/internal/tools/apply-patch";

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
		outputPad: 1,
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

test("apply_patch self rendering applies outputPad to cached calls and settled results", () => {
	const tool = createApplyPatchToolDefinition() as Record<string, any>;
	const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text,
		bold: (text: string) => text };
	const context = { state: {}, lastComponent: undefined, cwd: process.cwd(), executionStarted: true,
		expanded: false, isError: false, outputPad: 0 };
	const call = tool.renderCall(undefined, theme, context);
	assert.equal(call.render(40).find((line: string) => line.trim()), "apply_patch applying".padEnd(40));
	context.outputPad = 1;
	assert.equal(tool.renderCall(undefined, theme, context), call);
	assert.equal(call.render(40).find((line: string) => line.trim()), " apply_patch applying".padEnd(40));
	const result = { content: [{ type: "text", text: "Done" }], details: { files: [{ kind: "add", path: "test.txt" }] } };
	for (const outputPad of [0, 1]) {
		context.outputPad = outputPad;
		assert.equal(tool.renderResult(result, {}, theme, context).render(40)[0], `${" ".repeat(outputPad)}Applied`.padEnd(40));
		assert.equal(call.render(40).find((line: string) => line.trim()), `${" ".repeat(outputPad)}apply_patch applied`.padEnd(40));
		context.isError = true;
		assert.equal(tool.renderResult(result, {}, theme, context).render(40)[0], `${" ".repeat(outputPad)}Done`.padEnd(40));
		context.isError = false;
	}
});
