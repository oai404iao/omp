import assert from "node:assert/strict";
import { readFileSync, renameSync } from "node:fs";
import { test } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessageEventStream, type ToolCall } from "@earendil-works/pi-ai";
import { assistant, deferred, fixture, usage, waitUntil } from "./support/fixture.ts";

test("real SDK transcript follows streaming text and settles without duplicate responses or new requests", async t => {
	const f = await fixture(t);
	let events: AssistantMessageEventStream | undefined;
	f.modelRuntime.registerProvider("scripted", {
		baseUrl: "http://scripted.invalid", apiKey: "test", api: "openai-responses",
		models: [{ id: "echo", name: "Echo", reasoning: false, input: ["text"], cost: usage.cost, contextWindow: 100000, maxTokens: 1000 }],
		streamSimple: () => {
			events = createAssistantMessageEventStream();
			return events;
		},
	});
	await f.coordinator.spawn(f.caller, { task_name: "streaming", message: "Observe this response", fork_turns: "none" });
	await waitUntil(() => !!events);
	const message = { ...assistant(""), content: [], stopReason: "pending" as const };
	events!.push({ type: "start", partial: message });
	const partial = { ...message, content: [{ type: "text" as const, text: "Live text" }] };
	events!.push({ type: "text_start", contentIndex: 0, partial });
	events!.push({ type: "text_delta", contentIndex: 0, delta: "Live text", partial });
	await waitUntil(() => f.coordinator.getTranscript("/root/streaming").entries.some(entry => entry.streaming && entry.text === "Live text"));
	const live = f.coordinator.getTranscript("/root/streaming");
	assert.equal(live.status, "running");
	assert(live.entries.some(entry => entry.text?.includes("Observe this response")));
	const nativeLive = live.entries.find(entry => entry.streaming && entry.kind === "assistant")?.message;
	assert(nativeLive?.role === "assistant");
	assert.equal(nativeLive.stopReason, "pending");
	assert.deepEqual(nativeLive.content, [{ type: "text", text: "Live text" }]);
	const final = { ...partial, stopReason: "stop" as const };
	events!.push({ type: "text_end", contentIndex: 0, content: "Live text", partial });
	events!.push({ type: "done", reason: "stop", message: final });
	events!.end();
	await f.idle();
	const settled = f.coordinator.getTranscript("/root/streaming");
	assert.equal(settled.entries.filter(entry => entry.kind === "assistant").length, 1);
	assert.equal(settled.entries.find(entry => entry.kind === "assistant")?.text, "Live text");
	const nativeFinal = settled.entries.find(entry => entry.kind === "assistant")?.message;
	assert(nativeFinal?.role === "assistant");
	assert.equal(nativeFinal.stopReason, "stop");
	assert.equal(nativeFinal.model, final.model);
	assert.equal(typeof nativeFinal.durationMs, "number");
	assert.equal(settled.entries.some(entry => entry.streaming), false);
	await f.restart();
	assert.deepEqual(f.coordinator.getTranscript("/root/streaming").entries, settled.entries);
});

test("recorded tool inputs/results remain readable after unload and inspection never writes or starts work", async t => {
	const replies: ToolCall[][] = [
		[{ type: "toolCall", id: "bash-call", name: "bash", arguments: { command: "printf 'observed output'" } }],
		[{ type: "toolCall", id: "write-call", name: "write", arguments: { path: "observed.txt", content: "first content" } }],
		[{ type: "toolCall", id: "edit-call", name: "edit", arguments: { path: "observed.txt", edits: [{ oldText: "first", newText: "updated" }] } }],
	];
	const f = await fixture(t, { reply: (_context, count) => replies[count - 1] ?? "All done" });
	await f.coordinator.spawn(f.caller, { task_name: "tools", message: "Use scripted tools" });
	await f.idle();
	const record = f.coordinator.treeStore.record("/root/tools");
	const before = readFileSync(record.sessionFile, "utf8");
	const timing = readFileSync(`${record.sessionFile}.telemetry.json`, "utf8");
	for (let i = 0; i < 3; i++) {
		const snapshot = f.coordinator.getTranscript("/root/tools");
		assert.equal(snapshot.error, undefined);
		assert.equal(snapshot.inheritedCount, 2);
		assert.equal(snapshot.entries.find(entry => entry.id === "tool:bash-call")?.result?.content[0]?.text, "observed output");
		assert.equal(snapshot.entries.find(entry => entry.id === "tool:bash-call")?.toolCallId, "bash-call");
		assert.equal(snapshot.entries.find(entry => entry.id === "tool:write-call")?.toolCallId, "write-call");
		assert.equal(snapshot.entries.find(entry => entry.id === "tool:edit-call")?.toolCallId, "edit-call");
		assert.equal(snapshot.entries.find(entry => entry.id === "tool:write-call")?.args?.content, "first content");
		assert.match(String(snapshot.entries.find(entry => entry.id === "tool:edit-call")?.result?.details?.diff), /updated/);
		assert.equal(typeof snapshot.entries.find(entry => entry.id === "tool:bash-call")?.result?.durationMs, "number");
		assert.equal(typeof snapshot.entries.find(entry => entry.id === "tool:write-call")?.result?.durationMs, "number");
		const toolOnly = snapshot.entries.find(entry => entry.kind === "assistant" && entry.message?.role === "assistant" &&
			entry.message.stopReason === "toolUse")?.message;
		assert(toolOnly?.role === "assistant");
		assert(toolOnly.content.some(block => block.type === "toolCall"));
		assert(!toolOnly.content.some(block => block.type === "text" && block.text.startsWith("Requested")));
	}
	assert.equal(f.requests.length, 4);
	assert.equal(readFileSync(record.sessionFile, "utf8"), before);
	assert.equal(readFileSync(`${record.sessionFile}.telemetry.json`, "utf8"), timing);
	await f.restart();
	assert.equal(f.coordinator.getTranscript("/root/tools").entries.filter(entry => entry.kind === "tool").length, 3);
	assert.equal(f.requests.length, 4);
});

test("transcript accessor enforces branch visibility, isolates missing files, and closes with the controller", async t => {
	const f = await fixture(t);
	const anchor = f.manager.getLeafId()!;
	await f.coordinator.spawn(f.caller, { task_name: "visible", message: "Work" });
	await f.idle();
	const record = f.coordinator.treeStore.record("/root/visible");
	renameSync(record.sessionFile, `${record.sessionFile}.unavailable`);
	assert(f.coordinator.getTranscript("/root/visible").error);
	assert.equal(f.coordinator.getTranscript("/root/visible").entries.length, 0);
	renameSync(`${record.sessionFile}.unavailable`, record.sessionFile);
	assert.equal(f.coordinator.getTranscript("/root/visible").error, undefined);
	f.manager.branch(anchor);
	assert.match(f.coordinator.getTranscript("/root/visible").error!, /not visible/);
	assert.equal(f.coordinator.getTranscript("/root/visible").entries.length, 0);
	assert(f.coordinator.getTranscript("/root/missing").error);
	const previous = f.coordinator;
	await f.restart();
	assert.equal(previous.getTranscript("/root/visible").closed, true);
});

test("viewing an active agent neither interrupts it nor admits another run", async t => {
	const finish = deferred<string>();
	const f = await fixture(t, { reply: () => finish.promise });
	await f.coordinator.spawn(f.caller, { task_name: "active", message: "Wait for completion" });
	await waitUntil(() => f.requests.length === 1);
	for (let i = 0; i < 5; i++) {
		assert.equal(f.coordinator.getTranscript("/root/active").status, "running");
		assert.equal(f.coordinator.activeCount, 1);
	}
	assert.equal(f.requests.length, 1);
	finish.resolve("Finished naturally");
	await f.idle();
	assert.equal(f.coordinator.getTranscript("/root/active").status, "completed");
});
