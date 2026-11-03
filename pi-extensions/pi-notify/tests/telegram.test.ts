import assert from "node:assert/strict";
import test from "node:test";
import { formatNotification, sendTelegramMessage, telegramEndpoint, terminalNotificationFromMessage, truncateSummary } from "../src/telegram.ts";

const settings = { enabled: true, botToken: "FAKE:TOKEN", chatId: "FAKE_CHAT", requestTimeoutMs: 1000 };

test("Telegram formatting preserves multiline text and escapes MarkdownV2 and code paths", () => {
	assert.equal(formatNotification("/work/demo", "waiting", "  first\r\n\r\n  second  "),
		"*项目:* `/work/demo`\n*状态:* 等待回复\n\n*概要:*\nfirst\n\n  second");
	const punctuation = "_*[]()~`>#+-=|{}.!\\";
	const escaped = Array.from(punctuation, character => `\\${character}`).join("");
	assert.equal(formatNotification("/work/a_`b\\c", "error", punctuation),
		"*项目:* `/work/a_\\`b\\\\c`\n*状态:* 错误\n\n*概要:*\n" + escaped);
	assert.match(formatNotification("", "completed", " \n "), /Pi 任务已完成$/);
});

test("Telegram summaries respect UTF-16 budgets without splitting emoji", () => {
	assert.equal(truncateSummary("中".repeat(3001)), "中".repeat(2999) + "…");
	assert.equal(truncateSummary("😀".repeat(2000)), "😀".repeat(1499) + "…");
	assert.equal(truncateSummary("abcdef", 1), "…");
	assert.equal(truncateSummary("abcdef", 0), "");
	for (const separator of ["\n\n", "\n", " "]) {
		assert.equal(truncateSummary("a".repeat(85) + separator + "b".repeat(30), 100), "a".repeat(85) + "…");
	}
	for (const content of ["中", "😀", "\\", "*", "`"]) {
		const formatted = formatNotification(content.repeat(5000), "waiting", content.repeat(5000));
		const parsed = formatted.replace("*项目:* `", "项目: ").replace("`\n*状态:*", "\n状态:")
			.replace("*概要:*", "概要:").replace(/\\(.)/gs, "$1");
		assert.ok(parsed.length <= 4096);
		assert.equal(Buffer.from(parsed).toString(), parsed);
	}
});

test("Telegram completion classification excludes aborted and intermediate messages", () => {
	assert.deepEqual(terminalNotificationFromMessage({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }, { type: "thinking", thinking: "private" }] }), { status: "completed", summary: "done" });
	assert.deepEqual(terminalNotificationFromMessage({ role: "assistant", stopReason: "error", errorMessage: "failure", content: [] }), { status: "error", summary: "failure" });
	assert.deepEqual(terminalNotificationFromMessage({ role: "assistant", stopReason: "stop", content: [] }, "task"), { status: "completed", summary: "task" });
	assert.equal(terminalNotificationFromMessage({ role: "assistant", stopReason: "length", content: [] })?.status, "completed");
	for (const message of [null, { role: "user", content: "secret" }, { role: "assistant", stopReason: "aborted" }, { role: "assistant", stopReason: "toolUse" }]) {
		assert.equal(terminalNotificationFromMessage(message), undefined);
	}
});

test("transport sends only the configured chat with MarkdownV2 and an abort signal", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => { globalThis.fetch = originalFetch; });
	let request: { url: string; init: RequestInit | undefined } | undefined;
	globalThis.fetch = (async (url, init) => {
		request = { url: String(url), init };
		return new Response(JSON.stringify({ ok: true }));
	}) as typeof fetch;
	await sendTelegramMessage(settings, "test");
	assert.equal(telegramEndpoint(settings.botToken), "https://api.telegram.org/botFAKE%3ATOKEN/sendMessage");
	assert.equal(request!.url, telegramEndpoint(settings.botToken));
	assert.equal(request!.init!.method, "POST");
	assert.deepEqual(JSON.parse(String(request!.init!.body)), { chat_id: "FAKE_CHAT", text: "test", parse_mode: "MarkdownV2", disable_web_page_preview: true });
	assert.ok(request!.init!.signal instanceof AbortSignal);
	assert.equal(request!.init!.signal.aborted, false);
});

test("transport exposes HTTP, API and network failures to explicit callers", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => { globalThis.fetch = originalFetch; });
	for (const [response, expected] of [
		[new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), { status: 401 }), /401/],
		[new Response(JSON.stringify({ ok: false, description: "rejected" })), /rejected/],
		[new Response("unavailable", { status: 503 }), /503/],
	] as const) {
		globalThis.fetch = async () => response;
		await assert.rejects(sendTelegramMessage(settings, "test"), expected);
	}
	globalThis.fetch = async () => { throw new Error("offline"); };
	await assert.rejects(sendTelegramMessage(settings, "test"), /offline/);
});

test("transport aborts a pending request at the configured timeout", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let signal: AbortSignal | undefined;
	const pending = sendTelegramMessage(settings, "test", async (_url, init) => {
		signal = init.signal;
		return new Promise((_resolve, reject) => {
			init.signal.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
		});
	});
	assert.equal(signal!.aborted, false);
	t.mock.timers.tick(999);
	assert.equal(signal!.aborted, false);
	t.mock.timers.tick(1);
	await assert.rejects(pending, /request aborted/);
	assert.equal(signal!.aborted, true);
});
