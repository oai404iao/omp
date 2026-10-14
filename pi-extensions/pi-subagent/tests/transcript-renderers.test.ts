import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme, ToolExecutionComponent, type Theme, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Container, Text, stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { builtinToolRenderers, readOnlyToolRenderers } from "../src/transcript-renderers.ts";

initTheme("dark", false);
const theme = { fg: (_color: unknown, text: string) => text, bg: (_color: unknown, text: string) => text,
	bold: (text: string) => text } as Theme;
type Context = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
const context = (): Context => ({
	args: {}, toolCallId: "fixture", state: {}, cwd: ".", executionStarted: true, argsComplete: true,
	lastComponent: undefined, durationMs: undefined, isPartial: false, expanded: false,
	showImages: false, isError: false, outputPad: 1, invalidate() {},
});

test("only the eight public builtin renderer hooks are selected, reserved names stay missing", () => {
	for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls", "powershell"]) {
		const hooks = builtinToolRenderers(name, ".");
		assert(hooks?.renderCall, name);
		assert(hooks?.renderResult, name);
		assert.deepEqual(Object.keys(hooks).sort(), ["renderCall", "renderResult", "renderShell"]);
		assert.equal("execute" in hooks, false);
	}
	for (const name of ["unknown", "__proto__", "constructor", "toString", "hasOwnProperty"]) {
		assert.equal(builtinToolRenderers(name, "."), undefined);
		assert.equal(readOnlyToolRenderers(name, undefined), undefined);
	}
	assert(readOnlyToolRenderers("custom", {}), "an explicit empty override is not a missing definition");
});

test("read-only context suppresses edit filesystem previews and shell clocks, patch suppresses not-started previews", () => {
	for (const name of ["edit", "bash", "powershell", "apply_patch", "custom"]) {
		const seen: Context[] = [];
		const hooks: ToolRenderers = {
			renderCall: (_args, _theme, ctx) => { seen.push(ctx); return new Text("call", 0, 0); },
			renderResult: (_result, _options, _theme, ctx) => { seen.push(ctx); return new Text("result", 0, 0); },
		};
		const readonly = readOnlyToolRenderers(name, hooks)!;
		const original = context();
		if (name === "apply_patch") original.executionStarted = false; // Native constructor's very first render.
		readonly.renderCall!({}, theme, original);
		readonly.renderResult!({ content: [], details: undefined }, { expanded: false, isPartial: false }, theme, original);
		for (const ctx of seen) {
			assert.equal(ctx.executionStarted, name === "apply_patch");
			assert.equal(ctx.argsComplete, name !== "edit");
			assert.equal(ctx.state, original.state);
			assert.equal(ctx.cwd, original.cwd);
		}
		assert.equal(original.executionStarted, name !== "apply_patch", "caller context is unchanged");
		assert.equal(original.argsComplete, true);
	}
});

test("native builtin collapsed shell uses last five lines, write first ten and read hidden", () => {
	const output = Array.from({ length: 15 }, (_, i) => `line_${i}`).join("\n");
	const ui = { requestRender() {} } as TUI;
	const render = (name: string, args: Record<string, unknown>) => {
		const component = new ToolExecutionComponent(name, name, args, { showImages: false },
			readOnlyToolRenderers(name, builtinToolRenderers(name, ".")), ui, ".");
		component.setArgsComplete();
		component.updateResult({ content: [{ type: "text", text: output }], isError: false, durationMs: 1200 });
		return stripTerminalSequences(component.render(100).join("\n"));
	};
	const shell = render("bash", { command: "printf fixture" });
	assert.match(shell, /line_10/);
	assert.match(shell, /line_14/);
	assert.doesNotMatch(shell, /line_0\b/);
	assert.match(shell, /Took 1.2s/);
	const write = render("write", { path: "file.txt", content: output });
	assert.match(write, /line_9\b/);
	assert.doesNotMatch(write, /line_10\b/);
	const read = render("read", { path: "file.txt" });
	assert.doesNotMatch(read, /line_0\b|line_14\b/);
});

test("native shell partial output starts no viewer timer or redraw loop", t => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	let renders = 0;
	const component = new ToolExecutionComponent("bash", "bash", { command: "fixture" }, {},
		readOnlyToolRenderers("bash", builtinToolRenderers("bash", ".")), { requestRender() { renders++; } } as TUI, ".");
	component.setArgsComplete();
	component.updateResult({ content: [{ type: "text", text: "partial output" }], isError: false }, true);
	const before = component.render(100).join("\n");
	const count = renders;
	t.mock.timers.tick(10_000);
	assert.equal(renders, count);
	assert.equal(component.render(100).join("\n"), before);
	assert.doesNotMatch(stripTerminalSequences(before), /Elapsed|Took/);
});

test("saved native edit diff never reads current files even when arguments are complete", async t => {
	let reads = 0;
	const mocked = t.mock.method(fs, "readFile", async () => { reads++; throw new Error("viewer must not read current files"); });
	syncBuiltinESMExports();
	try {
		const component = new ToolExecutionComponent("edit", "edit", {
			path: "/not-a-real-file.ts", edits: [{ oldText: "before", newText: "after" }],
		}, { showImages: false }, readOnlyToolRenderers("edit", builtinToolRenderers("edit", ".")),
		{ requestRender() {} } as TUI, ".");
		component.setArgsComplete();
		component.updateResult({
			content: [{ type: "text", text: "Edited file" }], details: { diff: "-1 saved_before\n+1 saved_after", firstChangedLine: 1 }, isError: false,
		});
		assert.match(stripTerminalSequences(component.render(100).join("\n")), /saved_before[\s\S]*saved_after/);
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(reads, 0);
	} finally {
		mocked.mock.restore();
		syncBuiltinESMExports();
	}
});

test("read-only renderer ownership disposes replaced call/result components once", () => {
	let disposed = 0;
	const renderer = readOnlyToolRenderers("custom", {
		renderCall: () => Object.assign(new Text("custom", 0, 0), { dispose() { disposed++; } }),
	})!;
	renderer.renderCall!({}, theme, context());
	renderer.renderCall!({}, theme, context());
	assert.equal(disposed, 1);
	renderer.dispose();
	renderer.dispose();
	assert.equal(disposed, 2);
});

test("a component shared by call/result remains alive until neither slot owns it", () => {
	let sharedDisposed = 0;
	let replacementDisposed = 0;
	const shared = Object.assign(new Text("shared", 0, 0), { dispose() { sharedDisposed++; } });
	const replacement = Object.assign(new Text("replacement", 0, 0), { dispose() { replacementDisposed++; } });
	let call: Text = shared;
	const renderer = readOnlyToolRenderers("custom", {
		renderCall: () => call,
		renderResult: () => shared,
	})!;
	renderer.renderCall!({}, theme, context());
	renderer.renderResult!({ content: [], details: undefined }, { expanded: false, isPartial: false }, theme, context());
	call = replacement;
	renderer.renderCall!({}, theme, context());
	assert.equal(sharedDisposed, 0, "the result slot still displays the original component");
	renderer.dispose();
	renderer.dispose();
	assert.equal(sharedDisposed, 1);
	assert.equal(replacementDisposed, 1);
});

test("replacing a container preserves descendants still displayed inside the other slot", () => {
	let heldDisposed = 0;
	let retiredDisposed = 0;
	let containerDisposed = 0;
	const held = Object.assign(new Text("held", 0, 0), { dispose() { heldDisposed++; } });
	const retired = Object.assign(new Text("retired", 0, 0), { dispose() { retiredDisposed++; } });
	const oldCall = Object.assign(new Container(), { dispose() { containerDisposed++; } });
	oldCall.addChild(held);
	oldCall.addChild(retired);
	const result = new Container();
	result.addChild(held);
	let call: Container | Text = oldCall;
	const renderer = readOnlyToolRenderers("custom", {
		renderCall: () => call,
		renderResult: () => result,
	})!;
	renderer.renderCall!({}, theme, context());
	renderer.renderResult!({ content: [], details: undefined }, { expanded: false, isPartial: false }, theme, context());
	call = new Text("replacement", 0, 0);
	renderer.renderCall!({}, theme, context());
	assert.equal(heldDisposed, 0);
	assert.equal(retiredDisposed, 1);
	assert.equal(containerDisposed, 1);
	renderer.dispose();
	renderer.dispose();
	assert.equal(heldDisposed, 1);
	assert.equal(retiredDisposed, 1);
	assert.equal(containerDisposed, 1);
});
