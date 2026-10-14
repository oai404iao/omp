import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS } from "../src/config.ts";
import { DESCRIPTOR_CUSTOM_TYPE } from "../src/store.ts";
import { buildTranscript } from "../src/transcript-data.ts";
import { LiveTranscript } from "../src/transcript-live.ts";
import { boundTranscript, transcriptArgs, transcriptContent, transcriptDetails, transcriptMessage, transcriptResult, transcriptText, TRANSCRIPT_BYTE_LIMIT, TRANSCRIPT_TEXT_LIMIT } from "../src/transcript-text.ts";
import { DESCRIPTOR_VERSION, type AgentRecord } from "../src/types.ts";
import type { TranscriptEntry } from "../src/dashboard-types.ts";
import { assistant } from "./support/fixture.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

function record(): AgentRecord {
	return {
		descriptor: {
			version: DESCRIPTOR_VERSION, id: "child", path: "/root/test", parentPath: "/root", depth: 1,
			cwd: "/workspace", createdAt: "2026-10-08T00:00:00Z",
			agent: { name: "worker", description: "worker", systemPrompt: "", source: "user" },
			model: { provider: "fixture", id: "fixture" }, thinkingLevel: "off", forkTurns: "all",
			settings: DEFAULT_SETTINGS, anchorId: "anchor",
		},
		sessionFile: "/unused", status: "completed", mailbox: [],
	};
}
function session() {
	const manager = SessionManager.inMemory();
	manager.appendMessage(assistant("inherited parent"));
	manager.appendCustomEntry(DESCRIPTOR_CUSTOM_TYPE, record().descriptor);
	return manager;
}

test("transcript is owned raw canonical history, including pre-compaction messages", () => {
	const manager = session();
	const first = manager.appendMessage(assistant("owned before compaction"));
	manager.appendCompaction("compact summary", first, 100);
	manager.appendMessage(assistant("owned after compaction"));
	const data = buildTranscript(record(), manager.getBranch());
	assert.equal(data.inheritedCount, 1);
	assert.equal(data.before, undefined);
	assert(data.entries.some(entry => entry.text === "owned before compaction"));
	assert(data.entries.some(entry => entry.text?.includes("compact summary")));
	assert(!data.entries.some(entry => entry.text?.includes("inherited parent")));
	manager.branch(first);
	manager.appendMessage(assistant("alternate"));
	assert(!buildTranscript(record(), manager.getBranch()).entries.some(entry => entry.text === "owned after compaction"));
	assert.match(buildTranscript(record(), []).error!, /boundary/);
});

test("history pages have stable cursors and expose every owned assistant exactly once", () => {
	const manager = session();
	const expected: string[] = [];
	for (let i = 0; i < 135; i++) expected.push(manager.appendMessage(assistant(`response ${i}`)));
	let page = buildTranscript(record(), manager.getBranch());
	const ids = page.entries.map(entry => entry.id);
	while (page.before) {
		page = buildTranscript(record(), manager.getBranch(), [], page.before);
		ids.unshift(...page.entries.map(entry => entry.id));
	}
	assert.deepEqual(ids, expected.map(id => `assistant:${id}`));
	const pageBefore = buildTranscript(record(), manager.getBranch(), [], `assistant:${expected[60]}`);
	assert.equal(pageBefore.entries.at(-1)?.id, `assistant:${expected[59]}`);
	assert.match(buildTranscript(record(), manager.getBranch(), [], "missing").error!, /cursor/);
});

test("tools use recorded arguments and results; nested output is explicitly unavailable after unload", () => {
	const manager = session();
	manager.appendMessage({
		...assistant(""), stopReason: "toolUse",
		content: [{ type: "toolCall", id: "call", name: "edit", arguments: { path: "test.ts", edits: [{ oldText: "a", newText: "b" }] } }],
	});
	manager.appendMessage({
		role: "toolResult", toolCallId: "call", toolName: "edit", timestamp: Date.now(), isError: false,
		content: [{ type: "text", text: "Changed" }], details: { diff: "-a\n+b", firstChangedLine: 1 },
		nestedCalls: { complete: false, calls: [{ id: "call/1", name: "bash", status: "ok", arguments: { command: "pwd" } }] },
	});
	const data = buildTranscript(record(), manager.getBranch());
	assert.equal(data.entries.filter(entry => entry.id === "tool:call").length, 1);
	const tool = data.entries.find(entry => entry.id === "tool:call")!;
	assert.equal(tool.toolCallId, "call");
	assert.equal(tool.args?.path, "test.ts");
	assert.equal(tool.result?.details?.diff, "-a\n+b");
	assert.equal(data.entries.find(entry => entry.id === "tool:call/1")?.parentToolCallId, "call");
	assert.equal(data.entries.find(entry => entry.id === "tool:call/1")?.toolCallId, "call/1");
	assert.match(data.entries.find(entry => entry.id === "tool:call/1")?.text!, /not saved/);
	const overlay: TranscriptEntry = { ...tool, result: transcriptResult({ content: "stale unredacted result" }, false) };
	assert.equal(buildTranscript(record(), manager.getBranch(), [overlay]).entries.find(entry => entry.id === tool.id)?.result?.content[0]?.text, "Changed");
});

test("live transcript captures in-flight output, reconciles final IDs, and does not retain or mutate raw messages", () => {
	const trace = new LiveTranscript();
	const manager = session();
	const message = { ...assistant("working"), stopReason: "pending" as const };
	trace.observe({ type: "message_start", message });
	message.content = [{ type: "text", text: "working more" }, { type: "thinking", thinking: "PRIVATE" }];
	trace.observe({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " more", partial: message } });
	assert.equal(trace.snapshot()[0]?.text, "working more");
	assert.equal(trace.snapshot()[0]?.streaming, true);
	assert(!JSON.stringify(trace.snapshot()).includes("PRIVATE"));
	message.stopReason = "pending";
	const final = { ...message, stopReason: "stop" as const };
	trace.observe({ type: "message_end", message: final });
	const id = manager.appendMessage(final);
	const snapshot = trace.snapshot(manager.getBranch());
	assert.equal(snapshot[0]?.id, `assistant:${id}`);
	assert.equal(snapshot[0]?.streaming, false);
	assert.equal(buildTranscript(record(), manager.getBranch(), snapshot).entries.filter(entry => entry.kind === "assistant").length, 1);
	snapshot[0]!.text = "external mutation";
	const native = snapshot[0]!.message;
	assert(native?.role === "assistant");
	native.content = [{ type: "text", text: "external native mutation" }];
	assert.equal(trace.snapshot(manager.getBranch())[0]?.text, "working more");
	const untouched = trace.snapshot(manager.getBranch())[0]?.message;
	assert(untouched?.role === "assistant");
	assert.deepEqual(untouched.content, [{ type: "text", text: "working more" }]);
	trace.clear();
	assert.deepEqual(trace.snapshot(), []);
	assert.equal(final.content[1]?.type, "thinking");
});

test("live tools preserve identity and output across partial results and finish", () => {
	const trace = new LiveTranscript();
	trace.observe({ type: "tool_execution_start", toolCallId: "c/1", parentToolCallId: "c", toolName: "bash", args: { command: "pwd" } });
	assert.equal(trace.snapshot()[0]?.toolCallId, "c/1");
	trace.observe({ type: "tool_execution_update", toolCallId: "c/1", parentToolCallId: "c", toolName: "bash", args: { command: "pwd" }, partialResult: { content: [{ type: "text", text: "/work" }], details: undefined } });
	assert.equal(trace.snapshot()[0]?.result?.content[0]?.text, "/work");
	trace.observe({ type: "tool_execution_end", toolCallId: "c/1", parentToolCallId: "c", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "/workspace" }], details: undefined } });
	trace.observe({ type: "tool_execution_update", toolCallId: "c/1", parentToolCallId: "c", toolName: "bash", args: {}, partialResult: { content: [{ type: "text", text: "late" }], details: undefined } });
	trace.observe({ type: "tool_execution_start", toolCallId: "c/1", parentToolCallId: "c", toolName: "bash", args: { command: "late duplicate start" } });
	assert.equal(trace.snapshot().length, 1);
	assert.equal(trace.snapshot()[0]?.status, "success");
	assert.equal(trace.snapshot()[0]?.result?.content[0]?.text, "/workspace");
	trace.observe({ type: "tool_execution_start", toolCallId: "pending", toolName: "read", args: {} });
	trace.finish("interrupted");
	assert.equal(trace.snapshot().find(entry => entry.id === "tool:pending")?.status, "interrupted");
	const active = new LiveTranscript();
	for (let i = 0; i < 150; i++) active.observe({ type: "tool_execution_start", toolCallId: `${i}`, toolName: "write", args: { content: "x".repeat(50_000) } });
	assert(active.snapshot().length <= 100);
	assert(Buffer.byteLength(JSON.stringify(active.snapshot())) <= TRANSCRIPT_BYTE_LIMIT);
});

test("finalized live responses outside the latest page cannot reappear after newer history", () => {
	const manager = session();
	const trace = new LiveTranscript();
	for (let i = 0; i < 85; i++) {
		const message = assistant(`final ${i}`);
		trace.observe({ type: "message_start", message });
		trace.observe({ type: "message_end", message });
		manager.appendMessage(message);
	}
	const snapshot = trace.snapshot(manager.getBranch());
	const latest = buildTranscript(record(), manager.getBranch(), snapshot);
	assert.equal(latest.entries.length, 60);
	assert.equal(latest.entries[0]?.text, "final 25");
	assert.equal(latest.entries.at(-1)?.text, "final 84");
	const earlier = buildTranscript(record(), manager.getBranch(), snapshot, latest.before);
	assert.equal(earlier.entries.length, 25);
});

test("final assistant authority removes speculative calls and replaces provisional arguments", () => {
	const manager = session();
	const trace = new LiveTranscript();
	const partial = { ...assistant(""), stopReason: "pending" as const, content: [
		{ type: "toolCall" as const, id: "removed", name: "bash", arguments: { command: "PRIVATE" } },
		{ type: "toolCall" as const, id: "kept", name: "bash", arguments: { command: "PRIVATE" } },
	] };
	trace.observe({ type: "message_start", message: partial });
	const final = { ...partial, stopReason: "toolUse" as const, content: [
		{ type: "toolCall" as const, id: "kept", name: "bash", arguments: { command: "redacted" } },
	] };
	trace.observe({ type: "message_end", message: final });
	manager.appendMessage(final);
	const snapshot = trace.snapshot(manager.getBranch());
	assert(!snapshot.some(entry => entry.id === "tool:removed"));
	assert.equal(snapshot.find(entry => entry.id === "tool:kept")?.args?.command, "redacted");
	assert(!JSON.stringify(buildTranscript(record(), manager.getBranch(), snapshot)).includes("PRIVATE"));
	trace.observe({ type: "message_update", message: partial, assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "late", partial } });
	assert.equal(trace.snapshot(manager.getBranch()).length, snapshot.length);
});

test("display copies strip terminal controls and opaque fields, and bound text, nesting and page bytes", () => {
	const hostile = "\x1b[2J\x1b]8;;https://bad.test\x07link\x1b]8;;\x07\u202e\x00\r\n中文🙂";
	assert.equal(transcriptText(hostile), "link\n中文🙂");
	assert.match(transcriptText("x".repeat(100), 5), /truncated/);
	const args = transcriptArgs({ signature: "OPAQUE", thinkingSignature: "PRIVATE", content: hostile, edits: Array(100).fill({ newText: "x".repeat(10_000) }) });
	assert(!JSON.stringify(args).includes("OPAQUE"));
	assert(!JSON.stringify(args).includes("PRIVATE"));
	assert(Buffer.byteLength(JSON.stringify(args)) < 40_000);
	let containers: unknown = [];
	for (let depth = 0; depth < 6; depth++) containers = Array(32).fill(containers);
	assert(Buffer.byteLength(JSON.stringify(transcriptArgs({ value: containers }))) < 40_000);
	const circular: Record<string, unknown> = {};
	circular.self = circular;
	assert.doesNotThrow(() => transcriptArgs(circular));
	assert(transcriptContent(Array(2000).fill({ type: "image", data: "BINARY" })).length <= TRANSCRIPT_TEXT_LIMIT + 64);
	const entries: TranscriptEntry[] = Array.from({ length: 400 }, (_, i) => ({
		id: `${i}`, kind: "assistant", timestamp: i, status: "success", text: "文".repeat(16_384),
	}));
	const bounded = boundTranscript(entries);
	assert(Buffer.byteLength(JSON.stringify(bounded)) <= TRANSCRIPT_BYTE_LIMIT);
	assert(bounded.some(entry => entry.truncated));
	const oversized = boundTranscript([{ ...entries[0]!, id: "x".repeat(TRANSCRIPT_BYTE_LIMIT + 1) }]);
	assert(Buffer.byteLength(JSON.stringify(oversized)) <= TRANSCRIPT_BYTE_LIMIT);
	assert.match(oversized[0]?.text!, /metadata exceeds/);
	const trace = new LiveTranscript();
	trace.observe({ type: "tool_execution_start", toolCallId: "x".repeat(TRANSCRIPT_BYTE_LIMIT + 1), toolName: "bash", args: { command: "pwd" } });
	assert.equal(trace.snapshot()[0]?.id.length, 76);
	assert.equal(trace.snapshot()[0]?.toolCallId, trace.snapshot()[0]?.id.slice(5));
	assert.equal(trace.snapshot()[0]?.toolCallId?.length, 71);
	assert(Buffer.byteLength(JSON.stringify(trace.snapshot())) <= TRANSCRIPT_BYTE_LIMIT);
});

test("native assistant projection preserves real blocks and rendering metadata without mutating replay data", () => {
	const message = {
		...assistant(""), stopReason: "error" as const, errorMessage: "\x1b[31mRequest failed\x1b[0m",
		durationMs: 1250, responseModel: "actual-model", responseId: "response-id",
		providerThinkingLevel: "high", rawStopReason: "provider-error",
		content: [
			{ type: "text" as const, text: "First\nparagraph", textSignature: "OPAQUE" },
			{ type: "thinking" as const, thinking: "PRIVATE", thinkingSignature: "REPLAY" },
			{ type: "image" as const, data: "BINARY", mimeType: "image/png" },
			{ type: "toolCall" as const, id: "call", name: "edit", arguments: { path: "real.ts", secret: "ARGUMENTS" }, thoughtSignature: "OPAQUE" },
			{ type: "text" as const, text: "Last paragraph", textSignature: "REPLAY" },
		],
	};
	const raw = JSON.stringify(message);
	const projected = transcriptMessage(message as AgentMessage);
	assert(projected?.role === "assistant");
	assert.deepEqual(projected.content, [
		{ type: "text", text: "First\nparagraph" },
		{ type: "toolCall", id: "call", name: "edit", arguments: {} },
		{ type: "text", text: "Last paragraph" },
	]);
	assert.equal(projected.stopReason, "error");
	assert.equal(projected.errorMessage, "Request failed");
	assert.equal(projected.durationMs, 1250);
	assert.equal(projected.responseModel, "actual-model");
	assert.equal(projected.responseId, "response-id");
	assert.equal(projected.providerThinkingLevel, "high");
	assert.equal(projected.rawStopReason, "provider-error");
	assert.deepEqual(projected.usage, message.usage);
	projected.usage.cost.total = 99;
	assert.notEqual(message.usage.cost.total, 99);
	assert.equal(JSON.stringify(message), raw);
	assert(!/PRIVATE|REPLAY|OPAQUE|BINARY|ARGUMENTS/.test(JSON.stringify(projected)));
	const toolOnly = transcriptMessage({ ...assistant(""), stopReason: "toolUse", content: [
		{ type: "toolCall", id: "tool", name: "bash", arguments: { command: "pwd" } },
	] });
	assert(toolOnly?.role === "assistant");
	assert.deepEqual(toolOnly.content, [{ type: "toolCall", id: "tool", name: "bash", arguments: {} }]);
	const opaqueId = "\x1b[31mopaque-call-id\x1b[0m";
	const identity = transcriptMessage({ ...assistant(""), content: [
		{ type: "toolCall", id: opaqueId, name: "bash", arguments: {} },
	] });
	assert(identity?.role === "assistant");
	assert(identity.content[0]?.type === "toolCall");
	assert.equal(identity.content[0].id, opaqueId);
});

test("cold history preserves native user, custom, direct bash and summary roles", () => {
	const manager = session();
	manager.appendMessage({ role: "user", timestamp: 1, content: [
		{ type: "text", text: "User paragraph" }, { type: "image", data: "BINARY", mimeType: "image/png" },
	] });
	manager.appendCustomMessageEntry("example/custom", [
		{ type: "text", text: "Custom content" }, { type: "image", data: "BINARY", mimeType: "image/png" },
	], true, { state: { label: "Display state" }, thinkingSignature: "OPAQUE", image: { type: "image", data: "BINARY" } });
	manager.appendMessage({
		role: "bashExecution", timestamp: 2, command: "printf hi", output: "hi",
		exitCode: 0, cancelled: false, truncated: true, fullOutputPath: "/saved/output.txt", excludeFromContext: true,
	});
	const leaf = manager.getLeafId()!;
	manager.appendCompaction("Compacted summary", leaf, 12345);
	manager.branchWithSummary(manager.getLeafId()!, "Branch summary");
	const raw = JSON.stringify(manager.getBranch());
	const entries = buildTranscript(record(), manager.getBranch()).entries;
	const user = entries.find(entry => entry.message?.role === "user")?.message;
	assert(user?.role === "user");
	assert.deepEqual(user.content, [{ type: "text", text: "User paragraph" }]);
	const custom = entries.find(entry => entry.message?.role === "custom")?.message;
	assert(custom?.role === "custom");
	assert.equal(custom.customType, "example/custom");
	assert.deepEqual(custom.content, [{ type: "text", text: "Custom content" }]);
	assert.deepEqual(JSON.parse(JSON.stringify(custom.details)), { state: { label: "Display state" } });
	const bash = entries.find(entry => entry.message?.role === "bashExecution")?.message;
	assert(bash?.role === "bashExecution");
	assert.equal(bash.fullOutputPath, "/saved/output.txt");
	assert.equal(bash.exitCode, 0);
	assert.equal(bash.truncated, true);
	assert.equal(bash.excludeFromContext, true);
	const compaction = entries.find(entry => entry.message?.role === "compactionSummary")?.message;
	assert(compaction?.role === "compactionSummary");
	assert.equal(compaction.tokensBefore, 12345);
	assert.equal(compaction.summary, "Compacted summary");
	const branch = entries.find(entry => entry.message?.role === "branchSummary")?.message;
	assert(branch?.role === "branchSummary");
	assert.equal(branch.summary, "Branch summary");
	assert.equal(typeof branch.fromId, "string");
	assert.equal(JSON.stringify(manager.getBranch()), raw);
	assert(!/BINARY|OPAQUE/.test(JSON.stringify(entries)));
	for (const details of ["plain state", 123, true, null, ["first", { state: "second" }]]) {
		const projected = transcriptMessage({ role: "custom", customType: "example/custom", content: "text", display: true, timestamp: 1, details });
		assert(projected?.role === "custom");
		assert.deepEqual(JSON.parse(JSON.stringify(projected.details)), details);
	}
	assert(!JSON.stringify(transcriptDetails({ image: { type: "image", data: "BINARY" },
		embedded: { data: "BINARY", mimeType: "image/png" } })).includes("BINARY"));
});

test("tool rendering facts outrank unrelated details and durations survive live, cold and nested records", () => {
	const details = {
		...Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`unrelated${i}`, "x".repeat(200_000)])),
		diff: "-before\n+after", firstChangedLine: 12, patch: "*** Add File: native.ts\n+export const x = 1;",
		files: [{ path: "native.ts", kind: "add" }], exitCode: 7, fullOutputPath: "/saved/full.txt",
		truncated: true, truncation: { truncated: true, outputLines: 10, totalLines: 200 },
		thinkingSignature: "OPAQUE", images: [{ type: "image", data: "BINARY", mimeType: "image/png" }],
	};
	const copied = transcriptDetails(details);
	assert.equal(copied.diff, details.diff);
	assert.equal(copied.patch, details.patch);
	assert.equal(copied.exitCode, 7);
	assert.equal(copied.fullOutputPath, "/saved/full.txt");
	assert.equal(copied.firstChangedLine, 12);
	assert.equal(copied.truncated, true);
	assert.deepEqual(JSON.parse(JSON.stringify(copied.files)), details.files);
	assert.deepEqual(JSON.parse(JSON.stringify(copied.truncation)), details.truncation);
	assert(!/BINARY|OPAQUE/.test(JSON.stringify(copied)));
	assert(Buffer.byteLength(JSON.stringify(copied)) < 150_000);
	const manager = session();
	manager.appendMessage({
		...assistant(""), content: [{ type: "toolCall", id: "call", name: "apply_patch", arguments: { input: details.patch } }],
	});
	manager.appendMessage({
		role: "toolResult", toolCallId: "call", toolName: "apply_patch", timestamp: 10,
		content: [{ type: "text", text: "Changed" }], isError: false, durationMs: 56, details,
		nestedCalls: { complete: true, calls: [{ id: "call/1", name: "bash", status: "ok", durationMs: 23 }] },
	});
	const cold = buildTranscript(record(), manager.getBranch());
	assert.equal(cold.entries.find(entry => entry.id === "tool:call")?.result?.durationMs, 56);
	assert.equal(cold.entries.find(entry => entry.id === "tool:call/1")?.result?.durationMs, 23);
	assert.equal(cold.entries.find(entry => entry.id === "tool:call/1")?.result?.content[0]?.text, "");
	assert.equal(cold.entries.find(entry => entry.id === "tool:call/1")?.text, "Nested output was not saved by Pi.");
	assert.equal(cold.entries.find(entry => entry.id === "tool:call")?.result?.details?.patch, details.patch);
	const trace = new LiveTranscript();
	trace.observe({ type: "tool_execution_start", toolCallId: "live", toolName: "bash", args: {} });
	trace.observe({ type: "tool_execution_end", toolCallId: "live", toolName: "bash", isError: false, durationMs: 78,
		result: { content: [{ type: "text", text: "done" }], details, durationMs: 1 } });
	assert.equal(trace.snapshot()[0]?.result?.durationMs, 78);
	assert.equal(trace.snapshot()[0]?.result?.details?.exitCode, 7);
	assert.equal(transcriptResult({ content: "done", durationMs: 5 }, false).durationMs, 5);
});

test("structured native messages obey record, text, identifier and global byte bounds", () => {
	const projected = transcriptMessage({
		...assistant(""), content: [
			{ type: "text", text: "文".repeat(100_000) },
			{ type: "toolCall", id: "x".repeat(100_000), name: "bash", arguments: {} },
			...Array.from({ length: 1000 }, () => ({ type: "text" as const, text: "extra" })),
		],
	});
	assert(projected?.role === "assistant");
	assert(projected.content.length <= 257);
	assert(projected.content.some(block => block.type === "toolCall"));
	assert(projected.content.every(block => block.type !== "toolCall" || block.id.length <= 256));
	assert(Buffer.byteLength(JSON.stringify(projected)) < 100_000);
	const entries: TranscriptEntry[] = Array.from({ length: 400 }, (_, i) => ({
		id: String(i), timestamp: i, kind: "assistant", status: "success", message: projected,
	}));
	const bounded = boundTranscript(entries);
	assert(Buffer.byteLength(JSON.stringify(bounded)) <= TRANSCRIPT_BYTE_LIMIT);
	assert(bounded.some(entry => entry.truncated && !entry.message));
	const trace = new LiveTranscript();
	for (let i = 0; i < 150; i++) {
		const message = { ...assistant("文".repeat(100_000)), timestamp: i };
		trace.observe({ type: "message_start", message });
		trace.observe({ type: "message_end", message });
	}
	assert(Buffer.byteLength(JSON.stringify(trace.snapshot())) <= TRANSCRIPT_BYTE_LIMIT);
});

test("tabs and text-block boundaries survive display projections for native renderers", () => {
	const first = "\tfirst line\n\t\tindented code";
	const second = "column\tvalue";
	assert.equal(transcriptText(`\x1b[31m${first}\x1b[0m\u202e\x00`), first);
	const message = { ...assistant(""), content: [
		{ type: "text" as const, text: first }, { type: "text" as const, text: second },
	] };
	const projected = transcriptMessage(message);
	assert(projected?.role === "assistant");
	assert.deepEqual(projected.content, message.content);
	const user = transcriptMessage({ role: "user", content: message.content, timestamp: 1 });
	assert(user?.role === "user");
	assert.deepEqual(user.content, message.content);
	assert.equal(transcriptArgs({ content: first }).content, first);
	assert.equal(transcriptResult({ content: first, details: { diff: "-\told\n+\tnew" } }, false).details?.diff, "-\told\n+\tnew");
	const trace = new LiveTranscript();
	trace.observe({ type: "message_start", message });
	assert.equal(trace.snapshot()[0]?.text, `${first}\n${second}`);
	assert.deepEqual(trace.snapshot()[0]?.message, projected);
});

test("tool-only and empty assistant transcripts never invent bodies, including byte-limit fallback", () => {
	const manager = session();
	const trace = new LiveTranscript();
	const pending = { ...assistant(""), stopReason: "pending" as const, content: [] };
	trace.observe({ type: "message_start", message: pending });
	assert.equal(trace.snapshot()[0]?.text, "");
	const final = { ...assistant(""), stopReason: "toolUse" as const, content: [
		{ type: "toolCall" as const, id: "call", name: "bash", arguments: { command: "pwd" } },
	] };
	trace.observe({ type: "message_end", message: final });
	manager.appendMessage(final);
	const live = trace.snapshot(manager.getBranch());
	assert.equal(live.find(entry => entry.kind === "assistant")?.text, "");
	const cold = buildTranscript(record(), manager.getBranch());
	const assistantEntry = cold.entries.find(entry => entry.kind === "assistant")!;
	assert.equal(assistantEntry.text, "");
	assert(assistantEntry.message?.role === "assistant");
	assert(assistantEntry.message.content.some(block => block.type === "toolCall"));
	const large = transcriptMessage({ ...final, content: Array.from({ length: 256 }, (_, i) => ({
		type: "toolCall" as const, id: `${i}:${"x".repeat(200)}`, name: "bash", arguments: {},
	})) });
	const bounded = boundTranscript(Array.from({ length: 400 }, (_, i) => ({
		...assistantEntry, id: `assistant:${i}`, message: large,
	})));
	assert(bounded.some(entry => entry.kind === "assistant" && entry.truncated && !entry.message));
	assert(bounded.filter(entry => entry.kind === "assistant").every(entry => !entry.text));
	assert(!/Requested|Generating response|No visible response/.test(JSON.stringify(bounded)));
	manager.appendMessage({ ...assistant(""), stopReason: "error", errorMessage: "Actual failure" });
	assert.equal(buildTranscript(record(), manager.getBranch()).entries.find(entry =>
		entry.kind === "assistant" && entry.status === "error")?.text, "Actual failure");
});

test("tool argument completeness follows assistant finalization and execution boundaries", () => {
	const trace = new LiveTranscript();
	const pending = { ...assistant(""), stopReason: "pending" as const, content: [
		{ type: "toolCall" as const, id: "call", name: "edit", arguments: { path: "file.ts" } },
	] };
	trace.observe({ type: "message_start", message: pending });
	const tool = () => trace.snapshot().find(entry => entry.id === "tool:call")!;
	assert.equal(tool().toolCallId, "call");
	assert.equal(tool().argsComplete, false);
	trace.observe({ type: "message_update", message: pending,
		assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "args", partial: pending } });
	assert.equal(tool().argsComplete, false);
	const final = { ...pending, stopReason: "toolUse" as const };
	trace.observe({ type: "message_end", message: final });
	assert.equal(tool().argsComplete, true);
	trace.observe({ type: "tool_execution_start", toolCallId: "call", toolName: "edit", args: { path: "file.ts", edits: [] } });
	assert.equal(tool().argsComplete, true);
	trace.observe({ type: "tool_execution_update", toolCallId: "call", toolName: "edit", args: {},
		partialResult: { content: [{ type: "text", text: "working" }] } });
	assert.equal(tool().argsComplete, true);
	trace.observe({ type: "tool_execution_end", toolCallId: "call", toolName: "edit", isError: false,
		result: { content: [{ type: "text", text: "done" }] } });
	assert.equal(tool().argsComplete, true);
	const nested = new LiveTranscript();
	nested.observe({ type: "tool_execution_update", toolCallId: "nested", parentToolCallId: "outer", toolName: "bash", args: {},
		partialResult: { content: [] } });
	assert.equal(nested.snapshot()[0]?.argsComplete, true);
	assert.equal(nested.snapshot()[0]?.toolCallId, "nested");
});

test("renderer call identity stays opaque and distinct from UI cache identity", () => {
	const rawId = "\x1b[31mopaque-call\x1b[0m";
	const manager = session();
	const message = { ...assistant(""), content: [{ type: "toolCall" as const, id: rawId, name: "read", arguments: { path: "file.ts" } }] };
	manager.appendMessage(message);
	const cold = buildTranscript(record(), manager.getBranch()).entries.find(entry => entry.kind === "tool")!;
	assert.equal(cold.id, `tool:${rawId}`);
	assert.equal(cold.toolCallId, rawId);
	const trace = new LiveTranscript();
	trace.observe({ type: "message_start", message: { ...message, stopReason: "pending" } });
	assert.equal(trace.snapshot().find(entry => entry.kind === "tool")?.toolCallId, rawId);
	trace.observe({ type: "tool_execution_start", toolCallId: rawId, toolName: "read", args: { path: "file.ts" } });
	assert.equal(trace.snapshot().find(entry => entry.kind === "tool")?.toolCallId, rawId);
	trace.observe({ type: "tool_execution_end", toolCallId: rawId, toolName: "read", isError: false, result: { content: [] } });
	assert.equal(trace.snapshot().find(entry => entry.kind === "tool")?.toolCallId, rawId);
});
