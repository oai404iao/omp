import assert from "node:assert/strict";
import test from "node:test";
import {
	formatNotification,
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
