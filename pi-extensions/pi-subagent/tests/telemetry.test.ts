import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager, type AgentSession, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { AgentTelemetry, dashboardText } from "../src/telemetry.ts";
import { readRunTelemetry, writeRunTelemetry } from "../src/telemetry-store.ts";
import { persistPreparedSession } from "../src/providers.ts";
import { assistant, tempRoot } from "./support/fixture.ts";

function fixture(options: { brokenStorage?: boolean; brokenContext?: boolean; brokenChange?: boolean } = {}, t?: TestContext) {
	const root = t ? tempRoot(t) : undefined;
	const manager = root ? persistPreparedSession(SessionManager.create(root, join(root, "sessions"))) : SessionManager.inMemory();
	let listener: ((event: AgentSessionEvent) => void) | undefined;
	let changes = 0;
	let unsubscriptions = 0;
	let context: ReturnType<AgentSession["getContextUsage"]> = { tokens: 20, contextWindow: 100, percent: 20 };
	const errors: unknown[] = [];
	const session = {
		sessionManager: options.brokenStorage ? {
			getSessionFile() { throw new Error("storage failed"); },
		} : manager,
		subscribe(callback: typeof listener) { listener = callback; return () => { listener = undefined; unsubscriptions++; }; },
		getContextUsage() {
			if (options.brokenContext) throw new Error("context failed");
			return context;
		},
	} as unknown as AgentSession;
	const telemetry = new AgentTelemetry(session, "run", () => {
		changes++;
		if (options.brokenChange) throw new Error("render failed");
	}, error => { errors.push(error); });
	return {
		telemetry, manager, errors, emit(event: AgentSessionEvent) { listener?.(event); },
		setContext(next: typeof context) { context = next; },
		get changes() { return changes; }, get unsubscriptions() { return unsubscriptions; },
	};
}

test("sidecar start precedes work, finish stores duration/context once, and transcript is untouched", t => {
	const f = fixture({}, t);
	const file = f.manager.getSessionFile()!;
	const transcript = readFileSync(file, "utf8");
	const start = readRunTelemetry(file).records[0]!;
	assert.equal(start.kind, "run-start");
	assert.equal(f.manager.getEntries().length, 0);
	const active = f.telemetry.snapshot();
	assert.equal(typeof active.activeSince, "number");
	assert.equal(active.context?.live, true);
	f.setContext({ tokens: null, contextWindow: 100, percent: null });
	f.telemetry.finish("completed");
	f.telemetry.finish("completed");
	const entries = readRunTelemetry(file).records;
	assert.equal(entries.length, 2);
	const end = entries[1]!;
	assert.equal(end.kind, "run-end");
	assert.ok(end.durationMs! >= 0);
	assert.equal(end.context!.tokens, null);
	assert.equal(end.context!.live, false);
	assert.equal(f.telemetry.snapshot().activeSince, undefined);
	f.telemetry.dispose();
	f.telemetry.dispose();
	assert.equal(f.unsubscriptions, 1);
	assert.equal(readRunTelemetry(file).records.length, 2);
	assert.equal(readFileSync(file, "utf8"), transcript);
	assert.equal(f.manager.getEntries().length, 0);
});

test("tool phases and nested tools are deduplicated, activity and summaries are bounded", () => {
	const f = fixture();
	for (let n = 0; n < 60; n++) f.emit({
		type: "tool_execution_start", toolCallId: String(n), toolName: "read", args: { path: `file${n}`, secret: "do not show" },
	});
	f.emit({ type: "tool_execution_start", toolCallId: "nested", parentToolCallId: "59", toolName: "bash", args: { command: "SECRET" } });
	f.emit({ type: "tool_execution_end", toolCallId: "59", toolName: "read", isError: false, result: { content: "SECRET" } });
	f.emit({ type: "tool_execution_end", toolCallId: "nested", parentToolCallId: "59", toolName: "bash", isError: true, result: "SECRET" });
	const snapshot = f.telemetry.snapshot();
	assert.equal(snapshot.toolIds.length, 60);
	assert.deepEqual(snapshot.nestedToolIds, ["nested"]);
	assert.equal(snapshot.activity.length, 50);
	assert.equal(snapshot.activity.filter(item => item.id === "tool:59").length, 1);
	assert.equal(snapshot.activity.find(item => item.id === "tool:59")?.summary, "file59");
	assert.equal(snapshot.activity.find(item => item.id === "tool:nested")?.status, "error");
	assert.equal(JSON.stringify(snapshot).includes("SECRET"), false);
	assert.equal(JSON.stringify(snapshot).includes("do not show"), false);
	snapshot.activity[0]!.summary = "mutated externally";
	assert.equal(f.telemetry.snapshot().activity.some(item => item.summary === "mutated externally"), false);
});

test("responses expose only text; retries and compaction update a single phase record", () => {
	const f = fixture();
	f.emit({
		type: "message_end", message: {
			role: "assistant", content: [{ type: "thinking", thinking: "PRIVATE" }, { type: "text", text: "x".repeat(1000) }],
			api: "openai-responses", provider: "fixture", model: "fixture", timestamp: 1, stopReason: "stop",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		},
	});
	f.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 100, errorMessage: "PRIVATE" });
	f.emit({ type: "auto_retry_end", attempt: 1, success: true });
	f.emit({ type: "compaction_start", reason: "threshold" });
	f.emit({ type: "compaction_end", reason: "threshold", result: undefined, aborted: false, willRetry: false });
	const snapshot = f.telemetry.snapshot();
	assert.equal(snapshot.activity.length, 3);
	assert.equal(snapshot.activity.find(item => item.kind === "response")?.summary.length, 160);
	assert.equal(JSON.stringify(snapshot.activity).includes("PRIVATE"), false);
	assert.equal(snapshot.activity.every(item => item.status === "success"), true);
});

test("observation failures cannot interrupt work, and disposal does not fabricate a run end", () => {
	const f = fixture({ brokenStorage: true, brokenContext: true, brokenChange: true });
	assert.doesNotThrow(() => {
		f.emit({ type: "tool_execution_start", toolCallId: "one", toolName: "read", args: {} });
		f.telemetry.snapshot();
		f.telemetry.finish("errored");
		f.telemetry.dispose();
	});
	assert.ok(f.errors.length >= 4);
	const unfinished = fixture();
	unfinished.telemetry.dispose();
	assert.equal(unfinished.manager.getEntries().length, 0);
	assert.equal(unfinished.unsubscriptions, 1);
});

test("terminal controls are stripped from summaries", () => {
	assert.equal(dashboardText("\x1b[31mread\x1b[0m\nfile\x00"), "read file");
	assert.equal(dashboardText("文".repeat(200)).length, 160);
});

test("sidecar I/O failure never calls custom append or changes a real SessionManager leaf", t => {
	const root = tempRoot(t);
	const manager = persistPreparedSession(SessionManager.create(root, join(root, "sessions")));
	manager.appendMessage(assistant("before"));
	const file = manager.getSessionFile()!;
	const before = readFileSync(file, "utf8");
	const leaf = manager.getLeafId();
	// Simulate an unavailable observation destination, while the actual SDK
	// transcript remains writable. Both start and end sidecar writes fail.
	t.mock.method(manager, "getSessionFile", () => join(root, "missing", "session.jsonl"));
	const customAppend = t.mock.method(manager, "appendCustomEntry", () => { throw new Error("Must not append telemetry"); });
	const errors: unknown[] = [];
	const session = {
		sessionManager: manager, subscribe() { return () => {}; }, getContextUsage() { return undefined; },
	} as unknown as AgentSession;
	const telemetry = new AgentTelemetry(session, "failed", () => {}, error => { errors.push(error); });
	assert.equal(telemetry.snapshot().timingPartial, true);
	telemetry.finish("completed");
	telemetry.dispose();
	assert.equal(errors.length, 2);
	assert.equal(customAppend.mock.callCount(), 0);
	assert.equal(manager.getLeafId(), leaf);
	assert.equal(readFileSync(file, "utf8"), before);
	manager.appendMessage(assistant("after"));
	const reopened = SessionManager.open(file);
	const last = reopened.getEntries().at(-1)!;
	assert.equal(last.parentId, leaf);
	assert.equal(reopened.getBranch().length, 2);
});

test("sidecar reader rejects corrupt metadata without repair; valid atomic replacement reopens", t => {
	const root = tempRoot(t);
	const file = join(root, "session.jsonl");
	assert.deepEqual(readRunTelemetry(file), { records: [] });
	writeRunTelemetry(file, [{ version: 1, kind: "run-start", runId: "one", startedAt: 100, anchorId: "leaf" }]);
	assert.equal(readRunTelemetry(file).records[0]!.runId, "one");
	writeFileSync(`${file}.telemetry.json`, "broken");
	assert.ok(readRunTelemetry(file).error);
	assert.equal(readFileSync(`${file}.telemetry.json`, "utf8"), "broken");
});

test("successful consecutive compactions use their durable entry IDs instead of duplicate run-level records", () => {
	const f = fixture();
	f.manager.appendMessage(assistant("before"));
	for (let n = 0; n < 2; n++) {
		f.emit({ type: "compaction_start", reason: "threshold" });
		const id = f.manager.appendCompaction("summary", f.manager.getLeafId()!, 20);
		f.emit({ type: "compaction_end", reason: "threshold", result: undefined, aborted: false, willRetry: false });
		const activities = f.telemetry.snapshot().activity.filter(item => item.kind === "compaction");
		assert.equal(activities.length, n + 1);
		assert.equal(activities.some(item => item.id === `compaction:${id}`), true);
		assert.equal(activities.every(item => item.status === "success"), true);
	}
});
