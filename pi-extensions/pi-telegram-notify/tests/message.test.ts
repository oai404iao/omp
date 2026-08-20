import assert from "node:assert/strict";
import test from "node:test";
import {
	formatNotification,
	lastAssistantMessageEntry,
	questionSummaryFromInput,
	questionSummaryFromPromptEvent,
	terminalNotificationFromMessage,
	truncateSummary,
} from "../src/message.js";

test("notification contains project, Chinese status, and a 30-character summary", () => {
	const message = formatNotification("/work/demo", "waiting", "这是一个很长的中文问题，用于确认摘要只保留最开始的三十个字符并且不会拆坏字符。");
	assert.equal(message.split("\n")[0], "项目: /work/demo");
	assert.equal(message.split("\n")[1], "状态: 等待回复");
	assert.match(message.split("\n")[2]!, /^概要: /);
	assert.equal(Array.from(truncateSummary("这是一个很长的中文问题，用于确认摘要只保留最开始的三十个字符并且不会拆坏字符。")).length, 31);
});

test("classifies completed, error, and non-terminal assistant messages", () => {
	assert.deepEqual(
		terminalNotificationFromMessage({
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "任务已经完成，改动已验证。" }],
		}),
		{ status: "completed", summary: "任务已经完成，改动已验证。" },
	);
	assert.deepEqual(
		terminalNotificationFromMessage({
			role: "assistant",
			stopReason: "error",
			errorMessage: "Invalid API key",
			content: [],
		}),
		{ status: "error", summary: "Invalid API key" },
	);
	assert.equal(
		terminalNotificationFromMessage({
			role: "assistant",
			stopReason: "toolUse",
			content: [],
		}),
		undefined,
	);
	assert.equal(
		terminalNotificationFromMessage({
			role: "assistant",
			stopReason: "aborted",
			content: [],
		}),
		undefined,
	);
});

test("selects the last assistant message entry from the active branch", () => {
	const first = {
		type: "message",
		id: "assistant-1",
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "assistant", stopReason: "error", content: [] },
	};
	const last = {
		type: "message",
		id: "assistant-2",
		parentId: "tool-result",
		timestamp: "2026-01-01T00:00:03.000Z",
		message: { role: "assistant", stopReason: "stop", content: [] },
	};
	assert.deepEqual(
		lastAssistantMessageEntry([
			first,
			{ type: "model_change", id: "model", parentId: first.id, timestamp: "2026-01-01T00:00:01.000Z", provider: "test", modelId: "test" },
			{ type: "message", id: "tool-result", parentId: "model", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "toolResult" } },
			last,
			{ type: "label", id: "label", parentId: last.id, timestamp: "2026-01-01T00:00:04.000Z", targetId: last.id, label: "active" },
		] as any),
		{ id: last.id, message: last.message },
	);
});

test("uses the first question for both supported ask-user-question shapes", () => {
	assert.equal(
		questionSummaryFromInput({ questions: [{ question: "Should I continue?" }] }),
		"Should I continue?",
	);
	assert.equal(
		questionSummaryFromPromptEvent({ questions: [{ question: "Which option?" }] }),
		"Which option?",
	);
});
