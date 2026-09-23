import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { findContinuationTarget } from "../src/target.js";

function fixture() {
	const manager = SessionManager.inMemory();
	const user = manager.appendMessage({ role: "user", content: "PRIVATE", timestamp: 1 });
	const result = manager.appendMessage({
		role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "ORIGINAL" }],
		isError: false, timestamp: 2,
	});
	return { manager, user, result };
}

function answer(manager: SessionManager, text: string, stopReason: "stop" | "error" = "stop") {
	return manager.appendMessage({
		role: "assistant", api: "openai-responses", provider: "fixture", model: "test", timestamp: 3,
		content: [{ type: "text", text }], stopReason,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	});
}

test("continuation preserves replacements, omissions and the recovery edit leaf", () => {
	const { manager, user, result } = fixture();
	manager.appendContextEdit(user, null);
	manager.appendContextEdit(result, { content: "REDACTED" });
	const failed = answer(manager, "", "error");
	const leaf = manager.appendContextEdit(failed, null);
	for (const force of [false, true]) {
		const selected = findContinuationTarget(manager.getBranch(), force);
		assert.equal(selected.target?.id, leaf);
		assert.doesNotMatch(JSON.stringify(selected.context), /PRIVATE|ORIGINAL/);
		assert.match(JSON.stringify(selected.context), /REDACTED/);
	}
});

test("--force can discard a suffix but never edits to the inherited prefix", () => {
	const { manager, user, result } = fixture();
	const replacement = manager.appendContextEdit(result, { content: "REDACTED" });
	answer(manager, "normal answer");
	assert.equal(findContinuationTarget(manager.getBranch(), false).target, undefined);
	assert.equal(findContinuationTarget(manager.getBranch(), true).target?.id, replacement);
	manager.appendContextEdit(user, null);
	assert.match(findContinuationTarget(manager.getBranch(), true).reason!, /No safe continuation/);
});

test("an omitted tool result or retain-none compaction cannot be revived by force", () => {
	const { manager, result } = fixture();
	manager.appendContextEdit(result, null);
	for (const force of [false, true]) assert.equal(findContinuationTarget(manager.getBranch(), force).target, undefined);
	manager.branch(result);
	manager.appendCompaction("summary", null, 100);
	assert.equal(findContinuationTarget(manager.getBranch(), true).target, undefined);
});

test("target comparison supports in-memory non-JSON data without cloning it", () => {
	const { manager, result } = fixture();
	const entry = manager.getEntry(result)!;
	assert(entry.type === "message" && entry.message.role === "toolResult");
	const data: any = { value: 1n, fn: () => {} };
	data.self = data;
	entry.message.details = data;
	manager.appendContextEdit(result, { content: "REPLACEMENT" });
	const selected = findContinuationTarget(manager.getBranch(), false);
	assert.equal(selected.target?.id, manager.getLeafId());
	assert.equal((selected.context!.at(-1)!.message as any).details, data);
});
