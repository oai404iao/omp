import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { AssistantMessage, UserMessage, Usage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	completedContextEntries,
	completedTurnBoundaryId,
	ForkProvider,
	SpawnProvider,
} from "../src/providers.ts";

const roots: string[] = [];

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-subagent-provider-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const usage: Usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function user(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function assistant(text: string, stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "test",
		usage,
		stopReason,
		timestamp: Date.now(),
	};
}

test("fork provider copies only the latest balanced completed-turn prefix", async () => {
	const root = tempRoot();
	const cwd = join(root, "project");
	const sessions = join(root, "sessions");
	const parent = SessionManager.create(cwd, sessions);
	parent.appendModelChange("openai", "test");
	parent.appendThinkingLevelChange("low");
	parent.appendMessage(user("completed question"));
	const completedId = parent.appendMessage(assistant("completed answer", "stop"));
	parent.appendMessage(user("current question"));
	parent.appendMessage(assistant("calling subagent", "toolUse"));

	assert.equal(completedTurnBoundaryId(parent.getBranch()), completedId);
	const prepared = await new ForkProvider().prepare({ sessionManager: parent }, "one-shot");
	const context = prepared.sessionManager.buildSessionContext().messages;
	assert.deepEqual(
		context.map((message) => message.role),
		["user", "assistant"],
	);
	assert.equal((context[0] as UserMessage).content, "completed question");
	assert.equal(prepared.sessionManager.getHeader()?.parentSession, parent.getSessionFile());
	const childFile = prepared.sessionManager.getSessionFile();
	assert.ok(childFile && existsSync(childFile));
	await prepared.rollback();
	assert.equal(existsSync(childFile!), false);
});

test("spawn provider creates an empty child with parent lineage", async () => {
	const root = tempRoot();
	const parent = SessionManager.create(join(root, "project"), join(root, "sessions"));
	parent.appendMessage(user("question"));
	parent.appendMessage(assistant("answer", "stop"));

	const prepared = await new SpawnProvider().prepare({ sessionManager: parent }, "continuable");
	assert.deepEqual(prepared.sessionManager.buildSessionContext().messages, []);
	assert.equal(prepared.sessionManager.getHeader()?.parentSession, parent.getSessionFile());
	await prepared.rollback();
});

test("fork provider supports continuable inherited-context children", async () => {
	const root = tempRoot();
	const parent = SessionManager.create(
		join(root, "project"),
		join(root, "sessions"),
	);
	parent.appendMessage(user("question"));
	parent.appendMessage(assistant("answer", "stop"));
	const prepared = await new ForkProvider().prepare(
		{ sessionManager: parent },
		"continuable",
	);
	assert.deepEqual(
		prepared.sessionManager
			.buildSessionContext()
			.messages.map((message) => message.role),
		["user", "assistant"],
	);
	await prepared.rollback();
});

test("last_n_completed inherits only complete suffix turns and no control records", async () => {
	const root = tempRoot();
	const parent = SessionManager.create(
		join(root, "project"),
		join(root, "sessions"),
	);
	for (let turn = 1; turn <= 3; turn++) {
		parent.appendMessage(user(`question ${turn}`));
		parent.appendMessage(assistant(`answer ${turn}`, "stop"));
		if (turn === 2) {
			parent.appendCustomEntry("pi-subagent/descriptor", {
				shouldNotBeCopied: true,
			});
		}
	}
	parent.appendMessage(user("current question"));
	parent.appendMessage(assistant("calling child", "toolUse"));

	const prepared = await new ForkProvider().prepare(
		{ sessionManager: parent },
		"continuable",
		{ mode: "last_n_completed", completedTurns: 2 },
	);
	const context = prepared.sessionManager.buildSessionContext().messages;
	assert.deepEqual(
		context.map((message) => message.role),
		["user", "assistant", "user", "assistant"],
	);
	assert.equal((context[0] as UserMessage).content, "question 2");
	assert.equal(
		prepared.sessionManager
			.getEntries()
			.some(
				(entry) =>
					entry.type === "custom"
					&& entry.customType === "pi-subagent/descriptor",
			),
		false,
	);
	await prepared.rollback();
});

test("compaction summary remains inherited when the active suffix has no terminal assistant", async () => {
	const root = tempRoot();
	const parent = SessionManager.create(
		join(root, "project"),
		join(root, "sessions"),
	);
	parent.appendCompaction(
		"durable completed history",
		"missing-kept-entry",
		10_000,
	);
	parent.appendMessage(user("active question"));
	parent.appendMessage(assistant("calling child", "toolUse"));
	const contextEntries = parent.buildContextEntries();
	assert.deepEqual(
		completedContextEntries(
			contextEntries,
			{ mode: "all_completed" },
		).map((entry) => entry.type),
		["compaction"],
	);

	const prepared = await new ForkProvider().prepare(
		{ sessionManager: parent },
		"one-shot",
		{ mode: "last_n_completed", completedTurns: 3 },
	);
	const inherited = prepared.sessionManager.buildSessionContext().messages;
	assert.equal(inherited.length, 1);
	assert.equal(inherited[0]?.role, "custom");
	assert.match(
		inherited[0]?.role === "custom"
			? typeof inherited[0].content === "string"
				? inherited[0].content
				: ""
			: "",
		/durable completed history/,
	);
	await prepared.rollback();
});

test("last_n_completed keeps a compaction summary needed by a split retained turn", async () => {
	const root = tempRoot();
	const parent = SessionManager.create(
		join(root, "project"),
		join(root, "sessions"),
	);
	parent.appendMessage(user("original tool question"));
	const toolAssistant = assistant("calling tool", "toolUse");
	toolAssistant.content = [
		{
			type: "toolCall",
			id: "split-tool",
			name: "read",
			arguments: { path: "README.md" },
		},
	];
	const firstKeptEntryId = parent.appendMessage(toolAssistant);
	parent.appendMessage({
		role: "toolResult",
		toolCallId: "split-tool",
		toolName: "read",
		content: [{ type: "text", text: "tool output" }],
		isError: false,
		timestamp: Date.now(),
	});
	parent.appendCompaction(
		"summary containing the original user prefix",
		firstKeptEntryId,
		10_000,
	);
	parent.appendMessage(assistant("terminal answer", "stop"));

	const selected = completedContextEntries(
		parent.buildContextEntries(),
		{ mode: "last_n_completed", completedTurns: 1 },
	);
	assert.equal(selected[0]?.type, "compaction");
	const prepared = await new ForkProvider().prepare(
		{ sessionManager: parent },
		"one-shot",
		{ mode: "last_n_completed", completedTurns: 1 },
	);
	assert.deepEqual(
		prepared.sessionManager
			.buildSessionContext()
			.messages.map((message) => message.role),
		["custom", "assistant", "toolResult", "assistant"],
	);
	await prepared.rollback();
});

test("last_n_completed counts an error and automatic retry as one logical turn", async () => {
	const root = tempRoot();
	const parent = SessionManager.create(
		join(root, "project"),
		join(root, "sessions"),
	);
	parent.appendMessage(user("retry this question"));
	parent.appendMessage(assistant("retryable failure", "error"));
	parent.appendMessage(assistant("successful retry", "stop"));
	parent.appendMessage(user("active question"));
	parent.appendMessage(assistant("calling child", "toolUse"));

	const selected = completedContextEntries(
		parent.buildContextEntries(),
		{ mode: "last_n_completed", completedTurns: 1 },
	);
	assert.equal(
		selected.find(
			(entry) =>
				entry.type === "message"
				&& entry.message.role === "user",
		)?.type,
		"message",
	);
	const prepared = await new ForkProvider().prepare(
		{ sessionManager: parent },
		"one-shot",
		{ mode: "last_n_completed", completedTurns: 1 },
	);
	assert.deepEqual(
		prepared.sessionManager
			.buildSessionContext()
			.messages.map((message) => message.role),
		["user", "assistant", "assistant"],
	);
	assert.equal(
		(
			prepared.sessionManager
				.buildSessionContext()
				.messages[0] as UserMessage
		).content,
		"retry this question",
	);
	await prepared.rollback();
});

test("fork provider does not silently drop completed history from an ephemeral parent", async () => {
	const parent = SessionManager.inMemory("/tmp/project");
	parent.appendMessage(user("question"));
	parent.appendMessage(assistant("answer", "stop"));
	await assert.rejects(
		() => new ForkProvider().prepare({ sessionManager: parent }, "one-shot"),
		/cannot copy completed history/,
	);
});

for (const compacted of [false, true]) {
	for (const mode of ["all_completed", "last_n_completed"] as const) {
		test(`${mode} inherits conversation, not parent system authority (compacted=${compacted})`, async () => {
			const root = tempRoot();
			const parent = SessionManager.create(join(root, "project"), join(root, "sessions"));
			parent.appendMessage({
				role: "system", content: "PARENT_POLICY",
				toolsAdded: [{ name: "parent_only", description: "Parent-only tool", parameters: { type: "object" } }],
				timestamp: 1,
			});
			const first = parent.appendMessage(user("completed question"));
			parent.appendMessage({ role: "system", content: "PARENT_PATCH", timestamp: 2 });
			parent.appendMessage(assistant("completed answer", "stop"));
			if (compacted) parent.appendCompaction("durable summary", first, 10000);
			parent.appendMessage(user("in-flight question"));
			const prepared = await new ForkProvider().prepare({ sessionManager: parent }, "one-shot",
				mode === "all_completed" ? { mode } : { mode, completedTurns: 1 });
			const messages = prepared.sessionManager.buildSessionContext().messages;
			assert(messages.some((message) => message.role === "assistant"));
			assert(!messages.some((message) => message.role === "system"));
			assert.doesNotMatch(JSON.stringify(messages), /PARENT_POLICY|PARENT_PATCH|parent_only|in-flight/);
			if (compacted && mode === "all_completed") assert.match(JSON.stringify(messages), /durable summary/);
			await prepared.rollback();
		});
	}
}
