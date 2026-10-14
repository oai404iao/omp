import assert from "node:assert/strict";
import { test } from "node:test";
import {
	AssistantMessageComponent, BashExecutionComponent, BranchSummaryMessageComponent, CompactionSummaryMessageComponent,
	CustomMessageComponent, getMarkdownTheme, initTheme, SessionManager, ToolExecutionComponent, UserMessageComponent, type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text, stripTerminalSequences, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { TranscriptEntry, TranscriptSnapshot, TranscriptPresentation } from "../src/dashboard-types.ts";
import { TranscriptView } from "../src/transcript-view.ts";
import { builtinToolRenderers, readOnlyToolRenderers } from "../src/transcript-renderers.ts";
import { buildTranscript } from "../src/transcript-data.ts";
import { DESCRIPTOR_CUSTOM_TYPE } from "../src/store.ts";
import type { AgentRecord } from "../src/types.ts";
import { assistant } from "./support/fixture.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fit } from "../src/dashboard-view.ts";

initTheme("dark", false);
const theme = { fg: (_color: unknown, text: string) => text, bg: (_color: unknown, text: string) => text,
	bold: (text: string) => text } as Theme;
const entry = (id: string, text = id): TranscriptEntry => ({
	id, timestamp: 1, kind: "assistant", status: "success", text,
});
const snapshot = (entries: TranscriptEntry[], extra: Partial<TranscriptSnapshot> = {}): TranscriptSnapshot => ({
	path: "/root/review", status: "running", entries, inheritedCount: 3, ...extra,
});
function harness() {
	let renders = 0;
	const view = new TranscriptView({ requestRender: () => { renders++; } }, () => theme);
	return { view, get renders() { return renders; } };
}
const text = (view: TranscriptView, width = 90, height = 200) => stripTerminalSequences(view.viewport(width, height).join("\n"));
const nativeLines = (component: Component, width: number) => component.render(width)
	.map(line => fit(line.replace(/\x1b\]133;[^\x07]*\x07/g, ""), width));
const presentation = (extra: Partial<TranscriptPresentation> = {}): TranscriptPresentation => ({
	cwd: ".", revision: "fixture", outputPad: 1, resolveTool: (_name, fallback) => fallback,
	resolveMessage: () => undefined, markdownTransformers: [], ...extra,
});

test("structured assistant and user render exactly like native components, pure tool turns add no ghost heading", () => {
	const answer = { ...assistant(""), content: [{ type: "text" as const, text: "**first**\n\n\tindent\n\n```ts\n\tconst x = 1;\n```\n" }, { type: "text" as const, text: "`second`" }],
		stopReason: "error" as const, errorMessage: "recorded failure" };
	const user = { role: "user" as const, timestamp: 1, content: [{ type: "text" as const, text: "first\t" }, { type: "text" as const, text: "second\n\n    indented\n\nparagraph" }] };
	const pureTool = { ...assistant(""), content: [{ type: "toolCall" as const, id: "call", name: "read", arguments: { path: "file" } }] };
	for (const [message, expected] of [
		[answer, new AssistantMessageComponent(answer, true, getMarkdownTheme(), "", 1)],
		[user, new UserMessageComponent("first\tsecond\n\n    indented\n\nparagraph", getMarkdownTheme(), 1)],
		[pureTool, new AssistantMessageComponent(pureTool, true, getMarkdownTheme(), "", 1)],
	] as [AgentMessage, Component][]) {
		const { view } = harness();
		view.update(snapshot([{ ...entry("structured", "Requested read"), message }], { inheritedCount: 0 }));
		const wanted = nativeLines(expected, 100);
		assert.deepEqual(view.viewport(100, 200).slice(1, 1 + wanted.length), wanted);
		assert.doesNotMatch(text(view), /Requested read|assistant · success|user · info/);
		view.dispose();
	}
});

test("tool rendering equals native builtin/fallback components including ANSI, errors, metadata and recorded duration", () => {
	for (const name of ["bash", "powershell", "read", "write", "edit", "grep", "find", "ls", "unknown", "__proto__", "constructor", "toString"]) {
		const args = name === "write" ? { path: "file.txt", content: "first\n\tsecond" } :
			name === "edit" ? { path: "/does/not/exist.ts", edits: [{ oldText: "before", newText: "after" }] } :
				{ command: "printf fixture", path: "file.txt", pattern: "pattern", limit: 5 };
		const result = {
			content: [{ type: "text" as const, text: "first\nsecond\nthird" }], isError: name === "grep", durationMs: 1234,
			details: name === "edit" ? { diff: "-1 before\n+1 after", firstChangedLine: 1 } : { fullOutputPath: "/recorded/output.txt" },
		};
		const expected = new ToolExecutionComponent(name, "tool", args, { showImages: false, outputPad: 1 },
			readOnlyToolRenderers(name, builtinToolRenderers(name, ".")), { requestRender() {} } as TUI, ".");
		expected.setArgsComplete();
		expected.updateResult(result);
		const { view } = harness();
		view.update(snapshot([{ id: "tool", kind: "tool", toolName: name, timestamp: 1, status: result.isError ? "error" : "success", args, result }], { inheritedCount: 0 }));
		const wanted = nativeLines(expected, 100);
		assert.deepEqual(view.viewport(100, 200).slice(1, 1 + wanted.length), wanted, name);
		view.dispose();
	}
});

test("source-built bashExecution uses native complete/truncation rendering instead of the generic tool branch", () => {
	const manager = SessionManager.inMemory();
	manager.appendCustomEntry(DESCRIPTOR_CUSTOM_TYPE, { id: "boundary" });
	const message: AgentMessage = {
		role: "bashExecution", timestamp: 1, command: "fixture", output: "recorded output", exitCode: 2,
		cancelled: false, truncated: true, fullOutputPath: "/recorded/full-output.txt", excludeFromContext: true,
	};
	manager.appendMessage(message);
	const data = buildTranscript({ descriptor: { id: "boundary", path: "/root/test" }, status: "completed" } as AgentRecord, manager.getBranch());
	assert.equal(data.entries[0].kind, "tool");
	const expected = new BashExecutionComponent(message.command, { requestRender() {} } as TUI, true, 1);
	expected.setComplete(2, false, { truncated: true } as NonNullable<Parameters<BashExecutionComponent["setComplete"]>[2]>, message.fullOutputPath);
	expected.appendOutput(message.output);
	const { view } = harness();
	view.update(data);
	const wanted = nativeLines(expected, 100);
	assert.deepEqual(view.viewport(100, 200).slice(1, 1 + wanted.length), wanted);
	assert.match(text(view), /Output truncated\. Full output: \/recorded\/full-output.txt/);
	assert.match(text(view), /\(exit 2\)/);
	view.dispose();
});

test("restoring structured bashExecution metadata replaces a cached same-ID generic tool", () => {
	const { view } = harness();
	const generic: TranscriptEntry = {
		id: "same", kind: "tool", toolName: "bash", timestamp: 1, status: "success", args: { command: "generic fixture" },
		result: { content: [{ type: "text", text: "generic output" }], isError: false },
	};
	view.update(snapshot([generic]));
	assert.match(text(view), /generic output/);
	const message: AgentMessage = {
		role: "bashExecution", timestamp: 1, command: "restored fixture", output: "restored output", exitCode: 0,
		cancelled: false, truncated: true, excludeFromContext: true, fullOutputPath: "/saved/restored.txt",
	};
	view.update(snapshot([{ ...generic, message }]));
	const cache = (view as unknown as { cache: Map<string, { component: Component }> }).cache;
	assert.match(text(view), /Output truncated\. Full output: \/saved\/restored.txt/);
	assert(cache.get("same")?.component instanceof BashExecutionComponent);
	assert.doesNotMatch(text(view), /generic output|generic fixture/);
	view.dispose();
});

test("presentation-only Markdown transforms and explicit missing renderer decisions are honored", () => {
	const { view } = harness();
	view.update(snapshot([{ ...entry("assistant"), message: assistant("original content") }], {
		presentation: presentation({ markdownTransformers: [markdown => markdown.replace("original", "transformed")] }),
	}));
	assert.match(text(view), /transformed content/);
	view.update(snapshot([{ id: "tool", kind: "tool", toolName: "read", timestamp: 1, status: "success",
		args: { path: "file.txt" }, result: { content: [{ type: "text", text: "generic visible output" }], isError: false },
	}], { inheritedCount: 0, presentation: presentation({ revision: "missing", resolveTool: () => undefined }) }));
	const expected = new ToolExecutionComponent("read", "tool", { path: "file.txt" }, { showImages: false, outputPad: 1 },
		undefined, { requestRender() {} } as TUI, ".");
	expected.setArgsComplete();
	expected.updateResult({ content: [{ type: "text", text: "generic visible output" }], isError: false });
	const wanted = nativeLines(expected, 100);
	assert.deepEqual(view.viewport(100, 200).slice(1, 1 + wanted.length), wanted);
	view.dispose();
});

test("custom and summary roles use native components and extension renderer precedence", () => {
	const custom: AgentMessage = { role: "custom", timestamp: 1, customType: "fixture", content: "custom body", display: true };
	const compact: AgentMessage = { role: "compactionSummary", timestamp: 2, tokensBefore: 1000, summary: "compaction body" };
	const branch: AgentMessage = { role: "branchSummary", timestamp: 3, fromId: "opaque", summary: "branch body" };
	const renderer = () => new Text("extension custom body", 1, 0);
	const messages: [AgentMessage, Component][] = [
		[custom, new CustomMessageComponent(custom, renderer, getMarkdownTheme(), 1)],
		[compact, new CompactionSummaryMessageComponent(compact, getMarkdownTheme(), 1)],
		[branch, new BranchSummaryMessageComponent(branch, getMarkdownTheme(), 1)],
	];
	for (const [message, expected] of messages) {
		const { view } = harness();
		view.update(snapshot([{ ...entry("message"), kind: "notice", message }], {
			inheritedCount: 0, presentation: presentation({ resolveMessage: () => renderer }),
		}));
		const wanted = nativeLines(expected, 100);
		assert.deepEqual(view.viewport(100, 200).slice(1, 1 + wanted.length), wanted);
		view.dispose();
	}
});

test("streaming native components are retained, presentation changes dispose resources and no render loops occur", () => {
	const h = harness();
	let disposed = 0;
	let fallbackObserved = false;
	const component = new Text("custom tool", 0, 0) as Text & { dispose(): void };
	component.dispose = () => { disposed++; };
	const config = presentation({
		resolveTool: (_name, fallback) => { fallbackObserved = !!fallback; return { renderCall: () => component }; },
	});
	const tool: TranscriptEntry = { id: "stream", kind: "tool", toolName: "write", timestamp: 1, status: "running", args: { path: "file", content: "partial" }, streaming: true };
	h.view.update(snapshot([tool], { presentation: config }));
	h.view.viewport(100, 200);
	const cache = () => (h.view as unknown as { cache: Map<string, { component: Component }> }).cache;
	const first = cache().get("stream")!.component;
	h.view.update(snapshot([{ ...tool, args: { path: "file", content: "partial content" } }], { presentation: config }));
	h.view.viewport(100, 200);
	assert.equal(cache().get("stream")!.component, first);
	assert(fallbackObserved);
	assert.equal(h.renders, 0, "native setter render requests during layout do not schedule another layout");
	h.view.update(snapshot([tool], { presentation: presentation({ revision: "cold", outputPad: 2, cwd: "/other" }) }));
	assert.equal(disposed, 1);
	assert.notEqual(cache().get("stream")?.component, first);
	assert.match(text(h.view), /partial/);
	h.view.invalidate();
	assert.match(text(h.view), /partial/);
	h.view.dispose();
});

test("structured visible content is bounded with feedback without truncation flags for harmless sanitation", () => {
	const { view } = harness();
	const message = { ...assistant(""), content: [{ type: "text" as const, text: "\x1b[31msafe\x1b[0m" }] };
	view.update(snapshot([{ ...entry("safe"), message }]));
	assert.match(text(view), /safe/);
	assert.doesNotMatch(text(view), /content truncated/);
	view.update(snapshot([{ ...entry("huge"), message: { ...message, content: [{ type: "text", text: "long ".repeat(20_000) }] } }]));
	assert.match(text(view, 100, 500), /content truncated/);
	view.dispose();
});

test("streamed assistant segments update the retained native component through final error and theme invalidation", () => {
	const { view } = harness();
	const initial = { ...assistant("first segment"), stopReason: "pending" as const };
	const value: TranscriptEntry = { ...entry("streamed"), message: initial, streaming: true, status: "running" };
	view.update(snapshot([value]));
	view.viewport(100, 200);
	const cache = () => (view as unknown as { cache: Map<string, { component: Component }> }).cache;
	const component = cache().get(value.id)!.component;
	assert(component instanceof AssistantMessageComponent);
	const final = { ...initial, content: [
		{ type: "text" as const, text: "first segment\n\n" }, { type: "text" as const, text: "**final segment**" },
	], stopReason: "error" as const, errorMessage: "final recorded error" };
	view.update(snapshot([{ ...value, message: final, streaming: false, status: "error" }]));
	assert.match(text(view), /final segment/);
	assert.match(text(view), /final recorded error/);
	assert.equal(cache().get(value.id)!.component, component);
	view.invalidate();
	assert.match(text(view), /final recorded error/);
	assert.doesNotMatch(text(view), /assistant ·|streaming/);
	assert.equal(initial.content[0].type, "text");
	assert.equal(initial.content.length, 1, "source message is never mutated");
	view.dispose();
});

test("provisional native tool arguments remain incomplete, settle in place, and rebuild when reverting", () => {
	const { view } = harness();
	const states: boolean[] = [];
	const renderer = { renderCall: (_args: unknown, _theme: Theme, context: { argsComplete: boolean }) => {
		states.push(context.argsComplete);
		return new Text(context.argsComplete ? "complete arguments" : "incomplete arguments", 0, 0);
	} };
	const config = presentation({ resolveTool: () => renderer });
	const incomplete: TranscriptEntry = {
		id: "call", kind: "tool", toolName: "custom", status: "running", timestamp: 1,
		argsComplete: false, args: { provisional: true },
	};
	view.update(snapshot([incomplete], { presentation: config, inheritedCount: 0 }));
	const expected = new ToolExecutionComponent("custom", "call", incomplete.args, { showImages: false, outputPad: 1 },
		readOnlyToolRenderers("custom", renderer), { requestRender() {} } as TUI, ".");
	const wanted = nativeLines(expected, 100);
	assert.deepEqual(view.viewport(100, 200).slice(1, 1 + wanted.length), wanted);
	assert(states.every(state => !state), "neither native constructor nor provisional view sets complete");
	const cache = () => (view as unknown as { cache: Map<string, { component: Component }> }).cache;
	const first = cache().get("call")!.component;
	view.update(snapshot([{ ...incomplete, argsComplete: true, args: { complete: true } }], { presentation: config }));
	assert.match(text(view), /complete arguments/);
	assert.equal(cache().get("call")!.component, first);
	assert.equal(states.at(-1), true);
	view.update(snapshot([incomplete], { presentation: config }));
	assert.match(text(view), /incomplete arguments/);
	assert.notEqual(cache().get("call")!.component, first, "the SDK cannot reset its complete flag");
	assert.equal(states.at(-1), false);
	view.dispose();
});

test("native custom renderer context receives original opaque toolCallId rather than synthetic cache identity", () => {
	const { view } = harness();
	const seen: string[] = [];
	const actualId = "\x1b[31mactual_call\x1b[0m";
	const config = presentation({ resolveTool: () => ({
		renderCall: (_args, _theme, context) => {
			seen.push(context.toolCallId);
			return new Text("custom native rendering", 0, 0);
		},
	}) });
	const value: TranscriptEntry = {
		id: `tool:${actualId}`, toolCallId: actualId, kind: "tool", toolName: "custom", timestamp: 1, status: "running", args: {},
	};
	view.update(snapshot([value], { presentation: config }));
	assert.match(text(view), /custom native rendering/);
	assert(seen.every(id => id === actualId));
	assert(!view.viewport(100, 200).join("\n").includes(actualId), "renderer identities never become visible labels");
	const cache = () => (view as unknown as { cache: Map<string, { component: Component }> }).cache;
	const first = cache().get(value.id)!.component;
	view.update(snapshot([{ ...value, toolCallId: "replacement_original_call" }], { presentation: config }));
	text(view);
	assert.equal(seen.at(-1), "replacement_original_call");
	assert.notEqual(cache().get(value.id)!.component, first, "native context identity cannot change in place");
	view.update(snapshot([{ ...value, toolCallId: undefined }], { presentation: config }));
	text(view);
	assert.equal(seen.at(-1), value.id, "legacy records without original identity retain their existing fallback");
	view.dispose();
});

test("transcript uses native message/tool display with saved edit diff and no current-file preview", () => {
	const { view } = harness();
	view.update(snapshot([
		{ ...entry("task", "Check the **dashboard**."), kind: "user" },
		entry("answer", "I will inspect the event handling."),
		{ id: "edit", timestamp: 2, kind: "tool", status: "success", toolName: "edit",
			args: { path: "/does/not/exist.ts", edits: [{ oldText: "before", newText: "after" }] },
			result: { content: [{ type: "text", text: "Edited file" }], isError: false,
				details: { diff: "-1 before\n+1 after", firstChangedLine: 1 } } },
		{ id: "nested", timestamp: 3, kind: "tool", status: "error", toolName: "bash",
			parentToolCallId: "edit", args: { command: "pnpm run check" },
			result: { content: [{ type: "text", text: "Fixture failure" }], isError: true } },
		{ id: "cold-nested", timestamp: 4, kind: "tool", status: "error", toolName: "read",
			parentToolCallId: "edit", args: { path: "missing.ts" }, text: "Nested output not saved by Pi · recorded failure" },
	]));
	const output = text(view);
	for (const expected of ["READ ONLY", "inherited entries hidden", "dashboard", "event handling", "/does/not/exist.ts", "before", "after", "$ pnpm run check", "Fixture failure", "Nested output not saved by Pi", "recorded failure"]) {
		assert(output.includes(expected), expected);
	}
	assert.doesNotMatch(output, /ENOENT|could not read|Thinking/);
	view.dispose();
});

test("scrolling suspends follow, new records do not steal history position, End follows latest", () => {
	const { view } = harness();
	const entries = Array.from({ length: 20 }, (_, i) => entry(`record_${i}`, `unique_content_${i}`));
	view.update(snapshot(entries));
	assert.match(text(view, 80, 8), /unique_content_19/);
	view.scrollBy(-12);
	const before = text(view, 80, 8);
	assert.equal(view.isFollowing, false);
	view.update(snapshot([...entries, entry("new", "new_live_content")]));
	assert.equal(text(view, 80, 8), before);
	view.resume(snapshot([...entries, entry("new", "new_live_content")]));
	assert.equal(view.isFollowing, true);
	assert.match(text(view, 80, 8), /new_live_content/);
	view.dispose();
});

test("paused history retains finalized rows retired by the rolling latest window, but not transient rows", () => {
	const { view } = harness();
	const records = Array.from({ length: 61 }, (_, i) => entry(`record_${i}`, `rolling_content_${i}`));
	view.update(snapshot([...records.slice(0, 60), {
		...entry("live:assistant:1", "obsolete_transient_content"), streaming: true, status: "running",
	}], { before: "raw-record-0" }));
	view.scrollToStart();
	const before = text(view, 80, 10);
	assert.match(before, /rolling_content_0/);
	const latest = snapshot([...records.slice(1), entry("assistant:final", "canonical_final_answer")], { before: "raw-record-1" });
	view.update(latest);
	assert.equal(text(view, 80, 10), before, "source window rollover preserves the viewed first record");
	assert.equal(view.before, "raw-record-0", "the cursor still precedes the retained oldest history");
	const whole = text(view);
	assert.equal(whole.match(/rolling_content_0\b/g)?.length, 1);
	assert.equal(whole.match(/rolling_content_1\b/g)?.length, 1);
	assert.doesNotMatch(whole, /obsolete_transient_content/);
	view.resume(latest);
	assert.equal(view.before, "raw-record-1");
	assert.doesNotMatch(text(view), /rolling_content_0\b/);
	assert.match(text(view), /canonical_final_answer/);
	view.dispose();
});

test("previous pages survive refresh, latest transient assistant rows are replaced, tools merge by stable ID", () => {
	const { view } = harness();
	view.update(snapshot([entry("live:assistant:1", "partial"), {
		...entry("tool:1"), kind: "tool", toolName: "bash", status: "running", args: { command: "echo one" },
	}], { before: "raw-middle" }));
	view.update(snapshot([entry("old", "earlier_owned_content")], { before: "raw-oldest" }), true);
	assert.equal(view.before, "raw-oldest");
	view.update(snapshot([entry("assistant:done", "final answer"), {
		...entry("tool:1"), kind: "tool", toolName: "bash", status: "success", args: { command: "echo one" },
		result: { content: [{ type: "text", text: "one" }], isError: false },
	}], { before: "raw-middle" }));
	const output = text(view);
	assert.match(output, /earlier_owned_content/);
	assert.match(output, /final answer/);
	assert.doesNotMatch(output, /partial|streaming/);
	assert.equal(output.match(/\$ echo one/g)?.length, 1);
	assert.equal(view.before, "raw-oldest");
	view.dispose();
});

test("error and closed snapshots invalidate paged history and cached owned content", () => {
	for (const invalid of [{ error: "Agent is no longer visible on the canonical branch" }, { closed: true }]) {
		const { view } = harness();
		view.update(snapshot([entry("latest", "stale_latest_owned_text")], { before: "raw-latest" }));
		view.update(snapshot([entry("earlier", "stale_earlier_owned_text")], { before: "raw-earlier" }), true);
		assert.match(text(view), /stale_latest_owned_text/);
		assert.match(text(view), /stale_earlier_owned_text/);
		view.scrollToStart();
		view.update(snapshot([], invalid));
		assert.equal(view.before, undefined);
		assert.equal(view.closed, invalid.closed ?? false);
		assert.doesNotMatch(text(view), /stale_latest_owned_text|stale_earlier_owned_text/);
		if (invalid.error) assert.match(text(view), /no longer visible/);
		view.update(snapshot([entry("fresh", "fresh_visible_owned_text")], { status: "completed" }));
		assert.equal(view.status, "completed");
		assert.match(text(view), /fresh_visible_owned_text/);
		assert.doesNotMatch(text(view), /stale_latest_owned_text|stale_earlier_owned_text/);
		view.dispose();
	}
});

test("tool folding uses global state and individual hit regions without executing anything", () => {
	const { view } = harness();
	view.update(snapshot([{
		id: "bash", timestamp: 1, kind: "tool", status: "success", toolName: "bash", args: { command: "printf fixture" },
		result: { content: [{ type: "text", text: Array.from({ length: 15 }, (_, i) => `output_${i}`).join("\n") }], isError: false },
	}]));
	assert.doesNotMatch(text(view), /output_0\b/);
	view.toggleTools();
	assert.match(text(view), /output_0\b/);
	view.scrollToStart();
	const lines = stripTerminalSequences(view.viewport(90, 200).join("\n")).split("\n");
	const row = lines.findIndex(line => line.includes("$ printf"));
	assert.equal(view.toggleAt(row), true);
	assert.doesNotMatch(text(view), /output_0\b/);
	view.dispose();
});

test("ANSI-equivalent opaque identifiers remain distinct rows with independent tool folding", () => {
	const { view } = harness();
	const wrappedId = "\x1b[31mcall\x1b[0m";
	view.update(snapshot(["call", wrappedId].map((id, index) => ({
		id, timestamp: index + 1, kind: "tool", status: "success", toolName: "bash",
		parentToolCallId: "\x1b[31mparent\x1b[0m",
		args: { command: `fixture_${index}` },
		result: { content: [{ type: "text", text: Array.from({ length: 15 }, (_, line) => `tool_${index}_output_${line}`).join("\n") }], isError: false },
	}))));
	view.scrollToStart();
	let output = text(view);
	assert.equal(output.match(/\$ fixture_/g)?.length, 2, "distinct opaque IDs must not collapse during merge or cache lookup");
	assert(!view.viewport(90, 200).join("\n").includes(wrappedId), "opaque identities are never rendered");
	const row = (command: string) => stripTerminalSequences(view.viewport(90, 200).join("\n")).split("\n")
		.findIndex(line => line.includes(command));
	assert.equal(view.toggleAt(row("$ fixture_0")), true);
	output = text(view);
	assert.match(output, /tool_0_output_0\b/);
	assert.doesNotMatch(output, /tool_1_output_0\b/);
	assert.equal(view.toggleAt(row("$ fixture_1")), true);
	assert.match(text(view), /tool_1_output_0\b/);
	assert.equal(view.toggleAt(row("$ fixture_0")), true);
	output = text(view);
	assert.doesNotMatch(output, /tool_0_output_0\b/);
	assert.match(output, /tool_1_output_0\b/);
	view.dispose();
});

test("display copies sanitize controls, bound payloads, fit widths and survive resize/theme invalidation", () => {
	const { view } = harness();
	const hostile = "\x1b[2J\x1b]8;;https://evil.test\x07link\x1b]8;;\x07\x1b_pi:c\x07\u202e";
	const original = snapshot([
		entry("assistant", `${hostile}中文🙂 **safe**`),
		{ ...entry("user", hostile), kind: "user" },
		{ id: "bash", timestamp: 2, kind: "tool", status: "success", toolName: "bash", args: { command: hostile },
			result: { content: [{ type: "text", text: `safe_result${hostile}` }], isError: false } },
		entry("large", "长内容🙂".repeat(3000)),
	]);
	view.update(original);
	for (const width of [1, 2, 12, 40, 90]) {
		const lines = view.viewport(width, 20);
		assert.equal(lines.length, 20);
		for (const line of lines) assert(visibleWidth(line) <= width);
		assert.doesNotMatch(lines.join(""), /\x1b\[2J|\x1b_pi:c|\u202e|\x1b\]133;/);
	}
	view.invalidate();
	assert.match(text(view), /content truncated/);
	assert.equal(original.entries[0].text, `${hostile}中文🙂 **safe**`, "original messages are unchanged");
	view.dispose();
	assert.deepEqual(view.viewport(80, 20), []);
	view.update(original);
	assert.deepEqual(view.viewport(80, 20), []);
});

test("bounded previous-page windows disclose eviction and permit continued historical paging", () => {
	const { view } = harness();
	view.update(snapshot([entry("latest", "latest_unique")], { before: "cursor-latest" }));
	for (let page = 5; page >= 0; page--) {
		view.update(snapshot(Array.from({ length: 100 }, (_, index) =>
			entry(`page_${page}_${index}`, `page_${page}_${index} ${"a".repeat(4000)}`)), { before: `cursor-${page}` }), true);
	}
	view.scrollToStart();
	const output = text(view, 90, 20);
	assert.match(output, /Display window bounded/);
	assert.match(output, /page_0_0/);
	assert.equal(view.before, "cursor-0");
	view.resume(snapshot([entry("latest", "latest_unique")], { before: "cursor-latest" }));
	assert.match(text(view), /latest_unique/);
	assert.doesNotMatch(text(view), /Display window bounded/);
	view.dispose();
});

test("theme invalidation rebuilds cached native Markdown and tool components", () => {
	const { view } = harness();
	const state = snapshot([entry("assistant", "A **bold** message and `code`."), {
		id: "edit", timestamp: 2, kind: "tool", status: "success", toolName: "edit",
		result: { content: [], isError: false, details: { diff: "-1 before\n+1 after" } },
	}]);
	try {
		view.update(state);
		const dark = view.viewport(90, 200).join("\n");
		initTheme("light", false);
		view.invalidate();
		const light = view.viewport(90, 200).join("\n");
		assert.notEqual(light, dark, "theme-dependent native component caches are rebuilt");
		assert.equal(stripTerminalSequences(light), stripTerminalSequences(dark));
	} finally {
		initTheme("dark", false);
		view.dispose();
	}
});
