import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { AssistantMessage, UserMessage, Usage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { completedTurnBoundaryId, ForkProvider, SpawnProvider } from "../src/providers.ts";

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

test("fork provider rejects continuable mode", async () => {
	const parent = SessionManager.inMemory("/tmp/project");
	await assert.rejects(
		() => new ForkProvider().prepare({ sessionManager: parent }, "continuable"),
		/one-shot only/,
	);
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
