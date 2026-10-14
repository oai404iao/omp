import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme, type Theme, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { TranscriptView } from "../src/transcript-view.ts";
import { deferred, fixture, waitUntil } from "./support/fixture.ts";

const theme = {
	fg: (_color: unknown, text: string) => text,
	bg: (_color: unknown, text: string) => text,
	bold: (text: string) => text,
} as Theme;
const context = (cwd: string): Parameters<NonNullable<ToolRenderers["renderCall"]>>[2] => ({
	args: {}, toolCallId: "unused", invalidate() {}, state: {}, cwd, lastComponent: undefined, durationMs: undefined,
	executionStarted: false, argsComplete: true, isPartial: false, expanded: false, showImages: false, isError: false, outputPad: 1,
});

test("real child renderer resolver is reused only while resident; unloading falls back without reloading", async t => {
	const finish = deferred<string>();
	const f = await fixture(t, {
		settings: { inheritExtensions: true },
		reply: () => finish.promise,
		extension: `
import { Text } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-tui"))};
export default function(pi) {
  pi.registerTool({
    name: "view_marker", description: "Display fixture", parameters: { type: "object", properties: {} },
    async execute() { throw new Error("A viewer must never execute this tool"); },
    renderCall(args, _theme, context) { return new Text("native registered marker " + args.label + " cwd=" + context.cwd, 0, 0); }
  });
  pi.registerToolRenderer((name, next) => name === "view_marker" ?
    { renderCall: (args, _theme, context) => new Text("native resolver marker " + args.label + " call=" + context.toolCallId, 0, 0) } : next());
}
`,
	});
	await f.coordinator.spawn(f.caller, { task_name: "rendered", message: "Wait for completion" });
	await waitUntil(() => f.requests.length === 1);
	const active = f.coordinator.getTranscript("/root/rendered");
	assert.equal(active.presentation?.cwd, f.root);
	assert.match(active.presentation!.resolveTool("view_marker")!.renderCall!({ label: "display" }, theme, context(f.root))
		.render(120).join("\n"), /native resolver marker display/);
	assert.equal(f.requests.length, 1);
	assert.equal(f.coordinator.activeCount, 1);
	initTheme("dark", false);
	const view = new TranscriptView({ requestRender() {} }, () => theme);
	const marker = { id: "tool:marker", kind: "tool" as const, status: "success" as const,
		timestamp: Date.now(), toolName: "view_marker", toolCallId: "marker", args: { label: "display" } };
	view.update({ ...active, entries: [marker] });
	assert.match(stripTerminalSequences(view.viewport(120, 20).join("\n")), /native resolver marker display call=marker/);
	finish.resolve("Finished naturally.");
	await f.idle();
	const unloaded = f.coordinator.getTranscript("/root/rendered");
	assert.equal(unloaded.presentation?.revision, "cold");
	assert.notEqual(unloaded.presentation?.revision, active.presentation?.revision);
	assert.equal(unloaded.presentation?.resolveTool("view_marker"), undefined);
	view.update({ ...unloaded, entries: [marker] });
	const fallback = stripTerminalSequences(view.viewport(120, 20).join("\n"));
	assert.doesNotMatch(fallback, /native resolver marker/);
	assert.match(fallback, /view_marker/);
	view.dispose();
	assert.equal(f.requests.length, 1);
	await f.restart();
	assert.equal(f.coordinator.getTranscript("/root/rendered").presentation?.resolveTool("view_marker"), undefined);
	assert.equal(f.requests.length, 1);
});

test("source history dispatches original bash/custom/summary messages through native components", async t => {
	const f = await fixture(t);
	await f.coordinator.spawn(f.caller, { task_name: "history", message: "Finished task" });
	await f.idle();
	const record = f.coordinator.treeStore.record("/root/history");
	const { SessionManager } = await import("@earendil-works/pi-coding-agent");
	initTheme("dark", false);
	const manager = SessionManager.open(record.sessionFile);
	manager.appendMessage({
		role: "bashExecution", command: "printf history", output: "historical shell output",
		exitCode: 0, cancelled: false, truncated: true, fullOutputPath: "/fixture/full-output.txt", excludeFromContext: true,
		timestamp: Date.now(),
	});
	manager.appendCustomMessageEntry("custom-view", "custom transcript body", true, { fixture: "metadata" });
	manager.appendCompaction("recorded summary", manager.getLeafId()!, 200);
	const snapshot = f.coordinator.getTranscript("/root/history");
	const view = new TranscriptView({ requestRender() {} }, () => theme);
	try {
		view.update(snapshot);
		view.toggleTools();
		const output = stripTerminalSequences(view.viewport(100, 200).join("\n"));
		for (const expected of ["printf history", "historical shell output", "/fixture/full-output.txt", "custom-view",
			"custom transcript body", "recorded summary"]) assert(output.includes(expected), expected);
		assert.doesNotMatch(output, /assistant · success|user · info|\"command\":/);
		assert.equal(f.requests.length, 1);
	} finally { view.dispose(); }
});
