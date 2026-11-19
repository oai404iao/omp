import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";
import { createApplyPatchToolDefinition } from "@oai404iao/pi-codex-tools/internal/tools/apply-patch";

test("deferred apply_patch uses Pi’s fallback call, result and shell", () => {
	const tool = createApplyPatchToolDefinition({ deferRendering: true }) as Record<string, any>;
	assert.equal(tool.name, "apply_patch");
	assert.ok(tool.parameters.properties.input);
	assert.deepEqual(tool.parameters.required, ["input"]);
	assert.equal(tool.renderShell, undefined);
	assert.equal("renderCall" in tool, false);
	assert.equal("renderResult" in tool, false);
});

test("apply_patch renderer updates from a throttled filesystem preview", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-apply-patch-render-"));
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let resolvePreview: (() => void) | undefined;
	const previewReady = new Promise<void>((resolve, reject) => {
		timeout = setTimeout(() => reject(new Error("preview timed out")), 2000);
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
	t.after(() => {
		clearTimeout(timeout);
		clearTimeout(context.state.callComponent?.previewTimer);
		rmSync(cwd, { recursive: true, force: true });
	});
	writeFileSync(join(cwd, "existing.txt"), "before\n");
	const tool = createApplyPatchToolDefinition() as Record<string, any>;
	const theme = {
		fg(_color: string, text: string) { return text; },
		bold(text: string) { return text; },
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
	assert.equal(tool.renderCall(args, theme, context), component);
	const rendered = component.render(120).join("\n");
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

test("Pi frames apply_patch call and result together with a single outputPad", () => {
	initTheme("dark", false);
	const tool = createApplyPatchToolDefinition();
	for (const isError of [false, true]) {
		const component = new ToolExecutionComponent("apply_patch", "call", {}, {}, tool,
			{ requestRender() {} } as TUI, process.cwd());
		component.markExecutionStarted();
		component.updateResult({ content: [{ type: "text", text: isError ? "Patch failed" : "Done" }],
			details: isError ? undefined : { files: [{ kind: "add", path: "test.txt" }] }, isError });
		for (const outputPad of [0, 1]) {
			component.setOutputPad(outputPad);
			const pad = " ".repeat(outputPad);
			assert.deepEqual(component.render(40).map(line => stripTerminalSequences(line).trimEnd()), [
				"", "", // Pi’s tool separator and top padding
				...(isError ? [`${pad}apply_patch failed`, `${pad}Patch failed`]
					: [`${pad}apply_patch applied`, `${pad}A test.txt`, `${pad}Applied`]),
				"", // bottom padding after the result
			]);
		}
	}
});
