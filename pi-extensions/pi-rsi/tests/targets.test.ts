import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager, type SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { historyOutcomes, latestTarget } from "../src/targets.ts";

type Assistant = Extract<SessionMessageEntry["message"], { role: "assistant" }>;
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const call = { type: "toolCall", id: "call", name: "read", arguments: {} } as const;
function assistant(overrides: Partial<Assistant> = {}): Assistant {
	return {
		role: "assistant", api: "openai-responses", provider: "test", model: "test-model", usage,
		content: [{ type: "text", text: "answer" }], stopReason: "stop", timestamp: 0, ...overrides,
	};
}

function user(session: SessionManager) {
	return session.appendMessage({ role: "user", timestamp: 0, content: "instruction" });
}

// Each test starts at a user root; only the current leaf can move between branches.
function outcomeIds(session: SessionManager, idle = true) {
	return historyOutcomes(session.getTree()[0], session.getLeafId(), idle).map(entry => entry?.id ?? null).sort();
}

test("uses raw user and assistant entry IDs, not context, bookkeeping, or the session's newest sibling", () => {
	const session = SessionManager.inMemory();
	assert.equal(latestTarget(session.getBranch(), true), undefined);
	const instruction = user(session);
	session.appendMessage(assistant({ stopReason: "toolUse", content: [call] }));
	session.appendMessage({ role: "toolResult", toolCallId: "call", toolName: "read", content: [], isError: false, timestamp: 0 });
	session.appendCustomEntry("state", {});
	const answer = session.appendMessage(assistant());
	session.appendContextEdit(answer, null);
	session.appendCompaction("summary", null, 10);
	session.appendLabelChange(answer, "result");
	session.appendSessionInfo("name");
	const leaf = session.appendMessage({ role: "bashExecution", command: "pwd", output: "", cancelled: false, truncated: false, exitCode: 0, timestamp: 0 });
	user(session);
	session.appendMessage(assistant());
	session.branch(leaf);
	assert.deepEqual(latestTarget(session.getBranch(), true), { userMessageEntryId: instruction, finalAssistantEntryId: answer });
	assert.deepEqual(outcomeIds(session), [answer]);
});

test("an assistant ID requires a terminal result, not progress text, tool calls or an abort", () => {
	const cases: [Partial<Assistant>, boolean][] = [
		[{ stopReason: "stop", endTurn: false }, true],
		[{ stopReason: "length" }, true],
		[{ stopReason: "error", content: [], errorMessage: "provider unavailable" }, true],
		[{ stopReason: "error" }, true],
		[{ stopReason: "error", content: [], errorMessage: " " }, false],
		[{ stopReason: "aborted", errorMessage: "cancelled" }, false],
		[{ stopReason: "toolUse" }, false],
		[{ stopReason: "pending" }, false],
		[{ stopReason: "deferred" }, false],
		[{ content: [{ type: "thinking", thinking: "plan" }] }, false],
		[{ content: [{ type: "text", text: "\n  " }] }, false],
		[{ content: [{ type: "text", text: "checking…" }, call] }, false],
		[{ stopReason: "length", content: [{ type: "text", text: "checking…" }, call] }, false],
	];
	for (const [overrides, terminal] of cases) {
		const s = SessionManager.inMemory();
		const instruction = user(s);
		s.appendMessage(assistant()); // Never fall back to an earlier progress answer on this path.
		const id = s.appendMessage(assistant(overrides));
		const expected = terminal ? id : null;
		assert.deepEqual(latestTarget(s.getBranch(), true), { userMessageEntryId: instruction, finalAssistantEntryId: expected }, JSON.stringify(overrides));
		assert.deepEqual(outcomeIds(s), [expected], JSON.stringify(overrides));
	}
});

test("a successful retry replaces its error; alternative branches keep their own outcomes and stop at the next user", () => {
	const s = SessionManager.inMemory();
	const instruction = user(s);
	s.appendMessage(assistant({ stopReason: "error", errorMessage: "connection lost" }));
	const retried = s.appendMessage(assistant());
	user(s);
	s.appendMessage(assistant()); // Belongs to the next instruction.
	s.branch(retried);
	s.appendSessionInfo("fork label"); // Same actual endpoint as above.
	s.branch(instruction);
	const alternative = s.appendMessage(assistant());
	s.branch(instruction);
	s.appendMessage(assistant({ stopReason: "aborted" }));
	s.branch(instruction);
	s.appendMessage(assistant({ stopReason: "toolUse", content: [call] }));
	s.appendMessage({ role: "toolResult", toolCallId: "call", toolName: "read", content: [], isError: true, timestamp: 0 });
	assert.deepEqual(outcomeIds(s), [retried, alternative, null].sort());
});

test("a busy active path is incomplete even at an internal leaf; other history is still selectable", () => {
	const s = SessionManager.inMemory();
	const instruction = user(s);
	const first = s.appendMessage(assistant());
	const second = s.appendMessage(assistant());
	assert.deepEqual(outcomeIds(s, false), [null]);
	assert.deepEqual(latestTarget(s.getBranch(), false), { userMessageEntryId: instruction, finalAssistantEntryId: null });
	s.branch(first);
	assert.deepEqual(outcomeIds(s, false), [null, second].sort());
	assert.deepEqual(outcomeIds(s), [first, second].sort());
	const next = user(s);
	assert.deepEqual(latestTarget(s.getBranch(), false), { userMessageEntryId: next, finalAssistantEntryId: null });
	assert.deepEqual(outcomeIds(s, false), [first, second].sort());
});

test("custom messages alone are not outcomes, and a later custom-triggered reply is not assigned to the user", () => {
	for (const custom of [
		(s: SessionManager) => s.appendCustomMessageEntry("extension", "notification", true),
		(s: SessionManager) => s.appendMessage({ role: "custom", customType: "extension", content: "notification", display: false, timestamp: 0 }),
	]) {
		const s = SessionManager.inMemory();
		const instruction = user(s);
		const answer = s.appendMessage(assistant());
		custom(s);
		assert.deepEqual(outcomeIds(s), [answer]);
		s.appendMessage(assistant());
		assert.deepEqual(latestTarget(s.getBranch(), true), { userMessageEntryId: instruction, finalAssistantEntryId: null });
		assert.deepEqual(outcomeIds(s), [null]);
		s.branch(instruction);
		custom(s);
		s.appendMessage(assistant());
		assert.deepEqual(outcomeIds(s), [null]);
		const next = user(s);
		const nextAnswer = s.appendMessage(assistant());
		assert.deepEqual(latestTarget(s.getBranch(), true), { userMessageEntryId: next, finalAssistantEntryId: nextAnswer });
	}
});
