import assert from "node:assert/strict";
import test from "node:test";
import {
	formatNotification,
	isSubagentSession,
	lastAssistantMessageEntry,
	terminalNotificationFromMessage,
	truncateSummary,
} from "../src/message.js";

test("notification uses MarkdownV2 labels and code paths and preserves multiline summaries", () => {
	const summary = "这是一个很长的中文问题，用于确认摘要不再只保留最开始的三十个字符。\n\n第二段\n  缩进";
	assert.equal(formatNotification("/work/demo", "waiting", summary),
		`*项目:* \`/work/demo\`\n*状态:* 等待回复\n\n*概要:*\n${summary}`);
	assert.equal(truncateSummary("  line one\r\n\r\n  line two  "), "line one\n\n  line two");
});

test("escapes all MarkdownV2 punctuation and code delimiters in dynamic content", () => {
	const punctuation = "_*[]()~`>#+-=|{}.!\\";
	const escaped = Array.from(punctuation, (character) => `\\${character}`).join("");
	assert.equal(formatNotification("/work/a_`b\\c", "error", punctuation),
		"*项目:* `/work/a_\\`b\\\\c`\n*状态:* 错误\n\n*概要:*\n" + escaped);
	assert.match(formatNotification("", "completed", " \n "), /Pi 任务已完成$/);
});

test("summaries allow 3000 UTF-16 units including ellipsis without splitting emoji", () => {
	assert.equal(truncateSummary("中".repeat(3000)), "中".repeat(3000));
	assert.equal(truncateSummary("中".repeat(3001)), "中".repeat(2999) + "…");
	assert.equal(truncateSummary("😀".repeat(2000)), "😀".repeat(1499) + "…");
	assert.equal(truncateSummary("abcdef", 1), "…");
	assert.equal(truncateSummary("abcdef", 0), "");
});

test("truncation prefers nearby paragraph, line, and word boundaries", () => {
	for (const separator of ["\n\n", "\n", " "]) {
		assert.equal(truncateSummary("a".repeat(85) + separator + "b".repeat(30), 100), "a".repeat(85) + "…");
	}
	assert.equal(truncateSummary("short " + "b".repeat(120), 100).length, 100);
});

test("long paths and escaped summaries stay within Telegram's parsed text limit", () => {
	for (const content of ["中", "😀", "\\", "*", "`"]) {
		const message = formatNotification(content.repeat(5000), "waiting", content.repeat(5000));
		// Remove only the generated entities and escapes; the source Markdown can
		// exceed 4096 because Telegram measures text after entity parsing.
		const parsed = message
			.replace("*项目:* `", "项目: ").replace("`\n*状态:*", "\n状态:")
			.replace("*概要:*", "概要:").replace(/\\(.)/gs, "$1");
		assert.ok(parsed.length <= 4096);
		assert.equal(Buffer.from(parsed).toString(), parsed);
		assert.match(message, /…$/);
	}
});

test("only child descriptor entries suppress notifications", () => {
	assert.equal(isSubagentSession([]), false);
	assert.equal(isSubagentSession([{ type: "custom", customType: "pi-subagent/agent" }] as any), false);
	assert.equal(isSubagentSession([{ type: "custom_message", customType: "pi-subagent/descriptor" }] as any), false);
	assert.equal(isSubagentSession([{ type: "custom", customType: "pi-subagent/descriptor", data: null }] as any), true);
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
