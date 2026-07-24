import assert from "node:assert/strict";
import test from "node:test";
import { sendTelegramMessage, telegramEndpoint, type TelegramFetch } from "../src/telegram.js";

test("sends a plain Telegram message to the configured chat", async () => {
	let request: { url: string; body: string; method: string } | undefined;
	const fetchMock: TelegramFetch = async (url, init) => {
		request = { url, body: init.body, method: init.method };
		return {
			ok: true,
			status: 200,
			text: async () => JSON.stringify({ ok: true }),
		};
	};

	await sendTelegramMessage(
		{ enabled: true, botToken: "123:abc", chatId: "-10042", requestTimeoutMs: 1_000 },
		"项目: /work/demo\n状态: 完成\n概要: done",
		fetchMock,
	);

	assert.equal(telegramEndpoint("123:abc"), "https://api.telegram.org/bot123%3Aabc/sendMessage");
	assert.deepEqual(request, {
		url: "https://api.telegram.org/bot123%3Aabc/sendMessage",
		method: "POST",
		body: JSON.stringify({
			chat_id: "-10042",
			text: "项目: /work/demo\n状态: 完成\n概要: done",
			disable_web_page_preview: true,
		}),
	});
});

test("surfaces Telegram API failures to explicit callers", async () => {
	const fetchMock: TelegramFetch = async () => ({
		ok: false,
		status: 401,
		text: async () => JSON.stringify({ ok: false, description: "Unauthorized" }),
	});

	await assert.rejects(
		sendTelegramMessage(
			{ enabled: true, botToken: "123:abc", chatId: "42", requestTimeoutMs: 1_000 },
			"test",
			fetchMock,
		),
		/Telegram request failed \(401\): Unauthorized/,
	);
});
