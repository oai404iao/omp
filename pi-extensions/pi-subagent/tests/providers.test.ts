import assert from "node:assert/strict";
import fs, { existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { prepareChildSession, persistPreparedSession, recordChildSelection, SelectionPersistenceError } from "../src/providers.ts";
import { assistant, tempRoot } from "./support/fixture.ts";

for (const fork of ["all", "none"] as const) {
	test(`fork_turns=${fork}: completed balanced context only, no parent authority/control state`, t => {
		const root = tempRoot(t);
		const parent = SessionManager.create(root, join(root, "sessions"));
		parent.appendMessage({ role: "system", content: "PARENT_AUTHORITY", timestamp: 1 });
		parent.appendMessage({ role: "user", content: "completed question", timestamp: 1 });
		parent.appendMessage(assistant("completed answer"));
		parent.appendCustomEntry("pi-subagent/descriptor", { forbidden: true });
		parent.appendMessage({ role: "user", content: "in-flight question", timestamp: 2 });
		parent.appendMessage(assistant("tool call", "toolUse"));
		const child = prepareChildSession(parent, parent.getSessionDir(), fork);
		const context = JSON.stringify(child.buildSessionContext().messages);
		assert.equal(context.includes("completed question"), fork === "all");
		assert.doesNotMatch(context, /PARENT_AUTHORITY|in-flight|forbidden|tool call/);
		assert.equal(child.getHeader()?.parentSession, parent.getSessionFile());
	});
}

for (const edit of ["omit", "replace"] as const) {
	test(`context projection applies ${edit} before inheritance`, t => {
		const root = tempRoot(t);
		const parent = SessionManager.create(root, join(root, "sessions"));
		parent.appendMessage({ role: "user", content: "q", timestamp: 1 });
		const target = parent.appendMessage(assistant("PRIVATE"));
		parent.appendContextEdit(target, edit === "omit" ? null : { content: "REDACTED" });
		const child = prepareChildSession(parent, parent.getSessionDir(), "all");
		const context = JSON.stringify(child.buildSessionContext().messages);
		assert.doesNotMatch(context, /PRIVATE/);
		assert.equal(context.includes("REDACTED"), edit === "replace");
		assert.match(JSON.stringify(parent.getEntries()), /PRIVATE/);
	});
}

test("compaction and retained split tool turns remain balanced", t => {
	const root = tempRoot(t);
	const parent = SessionManager.create(root, join(root, "sessions"));
	parent.appendMessage({ role: "user", content: "q", timestamp: 1 });
	const firstKept = parent.appendMessage({
		...assistant("", "toolUse"), content: [{ type: "toolCall", id: "tool", name: "read", arguments: {} }],
	});
	parent.appendMessage({ role: "toolResult", toolCallId: "tool", toolName: "read",
		content: [{ type: "text", text: "result" }], isError: false, timestamp: 2 });
	parent.appendCompaction("summary of question", firstKept, 10000);
	parent.appendMessage(assistant("answer"));
	const child = prepareChildSession(parent, parent.getSessionDir(), "all");
	assert.deepEqual(child.buildSessionContext().messages.map(message => message.role), ["custom", "assistant", "toolResult", "assistant"]);
});

test("summary-only context survives an incomplete active turn", t => {
	const root = tempRoot(t);
	const parent = SessionManager.create(root, join(root, "sessions"));
	parent.appendCompaction("only summary", "missing", 10000);
	parent.appendMessage({ role: "user", content: "active", timestamp: 1 });
	parent.appendMessage(assistant("tools", "toolUse"));
	const child = prepareChildSession(parent, parent.getSessionDir(), "all");
	assert.match(JSON.stringify(child.buildSessionContext().messages), /only summary/);
	assert.doesNotMatch(JSON.stringify(child.buildSessionContext().messages), /active|tools/);
});

test("setup-only child JSONL is materialized before publication and can append normally", t => {
	const root = tempRoot(t);
	const parent = SessionManager.create(root, join(root, "sessions"));
	const child = prepareChildSession(parent, parent.getSessionDir(), "none");
	child.appendCustomEntry("pi-subagent/descriptor", { version: 5 });
	const reopened = persistPreparedSession(child);
	assert(existsSync(reopened.getSessionFile()!));
	reopened.appendMessage({ role: "user", content: "first real turn", timestamp: 1 });
	const disk = SessionManager.open(reopened.getSessionFile()!);
	assert.equal(disk.getSessionId(), child.getSessionId());
	assert.equal(disk.getEntries().filter(entry => entry.type === "message").length, 1);
});

test("ephemeral parents are rejected for both fork policies", () => {
	const parent = SessionManager.inMemory();
	for (const fork of ["all", "none"] as const) assert.throws(() => prepareChildSession(parent, parent.getSessionDir(), fork), /persisted/);
});

test("selection switches append Pi records without replacing history or adopting a routed response", t => {
	const root = tempRoot(t);
	const session = SessionManager.create(root, join(root, "sessions"));
	session.appendMessage({ role: "user", content: "retain this", timestamp: 1 });
	session.appendMessage(assistant("retain answer"));
	const original = structuredClone(session.getEntries());
	recordChildSelection(session, { provider: "router", id: "auto" }, "high");
	session.appendMessage({ ...assistant("physical response"), thinkingLevel: "off" });
	const before = session.getEntries().length;
	recordChildSelection(session, { provider: "router", id: "auto" }, "high");
	assert.equal(session.getEntries().length, before);
	recordChildSelection(session, { provider: "other", id: "reasoner" }, "low");
	assert.deepEqual(session.getEntries().slice(0, original.length), original);
	assert.deepEqual(session.getBranch().filter(entry => entry.type === "model_change")
		.map(entry => [entry.provider, entry.modelId]), [["router", "auto"], ["other", "reasoner"]]);
	assert.deepEqual(session.getBranch().filter(entry => entry.type === "thinking_level_change")
		.map(entry => entry.thinkingLevel), ["high", "low"]);
	assert.match(JSON.stringify(session.buildSessionContext().messages), /retain this.*retain answer.*physical response/);
	const reopened = SessionManager.open(session.getSessionFile()!);
	assert.deepEqual(reopened.getEntries(), session.getEntries());
});

test("selection append and sync failures use the specific persistence error marker", t => {
	const root = tempRoot(t);
	const session = SessionManager.create(root, join(root, "sessions"));
	const appendFailure = new Error("append failed");
	t.mock.method(session, "appendModelChange", () => { throw appendFailure; });
	assert.throws(() => recordChildSelection(session, { provider: "router", id: "auto" }, "high"),
		error => error instanceof SelectionPersistenceError && error.cause === appendFailure);
	t.mock.restoreAll();
	persistPreparedSession(session);
	const syncFailure = new Error("fsync failed");
	t.mock.method(fs, "fsyncSync", () => { throw syncFailure; });
	syncBuiltinESMExports();
	try {
		assert.throws(() => recordChildSelection(session, { provider: "router", id: "auto" }, "high"),
			error => error instanceof SelectionPersistenceError && error.cause === syncFailure);
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	}
});

test("reopening after a partial selection append repairs it from the authoritative descriptor", t => {
	const root = tempRoot(t);
	const session = SessionManager.create(root, join(root, "sessions"));
	session.appendMessage({ role: "user", content: "retain history", timestamp: 1 });
	recordChildSelection(session, { provider: "old", id: "model" }, "off");
	t.mock.method(session, "appendThinkingLevelChange", () => { throw new Error("thinking append failed"); });
	assert.throws(() => recordChildSelection(session, { provider: "new", id: "model" }, "high"),
		SelectionPersistenceError);
	t.mock.restoreAll();
	const reopened = SessionManager.open(session.getSessionFile()!);
	recordChildSelection(reopened, { provider: "old", id: "model" }, "off");
	const repaired = SessionManager.open(session.getSessionFile()!);
	assert.equal(repaired.getBranch().filter(entry => entry.type === "model_change").at(-1)?.provider, "old");
	assert.equal(repaired.getBranch().filter(entry => entry.type === "thinking_level_change").at(-1)?.thinkingLevel, "off");
	assert.match(JSON.stringify(repaired.buildSessionContext().messages), /retain history/);
});
