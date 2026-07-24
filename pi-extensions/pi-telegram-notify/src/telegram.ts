import type { ConfiguredTelegramNotifySettings } from "./settings.js";

export interface TelegramResponse {
	ok: boolean;
	status: number;
	text(): Promise<string>;
}

export type TelegramFetch = (
	url: string,
	init: {
		method: string;
		headers: Record<string, string>;
		body: string;
		signal: AbortSignal;
	},
) => Promise<TelegramResponse>;

function responseError(status: number, body: string): Error {
	let description = "";
	try {
		const payload = JSON.parse(body) as { description?: unknown };
		if (typeof payload.description === "string") description = payload.description;
	} catch {
		// The response body is optional and may not be JSON.
	}
	return new Error(description ? `Telegram request failed (${status}): ${description}` : `Telegram request failed (${status})`);
}

export function telegramEndpoint(botToken: string): string {
	return `https://api.telegram.org/bot${encodeURIComponent(botToken)}/sendMessage`;
}

/**
 * Deliver one plain-text Bot API message. Callers should catch failures so a
 * notification outage never changes Pi's task execution.
 */
export async function sendTelegramMessage(
	settings: ConfiguredTelegramNotifySettings,
	text: string,
	fetchImpl: TelegramFetch = globalThis.fetch as unknown as TelegramFetch,
): Promise<void> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), settings.requestTimeoutMs);
	timeout.unref?.();

	try {
		const response = await fetchImpl(telegramEndpoint(settings.botToken), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				chat_id: settings.chatId,
				text,
				disable_web_page_preview: true,
			}),
			signal: controller.signal,
		});
		const body = await response.text();
		if (!response.ok) throw responseError(response.status, body);

		try {
			const payload = JSON.parse(body) as { ok?: unknown; description?: unknown };
			if (payload.ok === false) {
				const description = typeof payload.description === "string" ? `: ${payload.description}` : "";
				throw new Error(`Telegram request was rejected${description}`);
			}
		} catch (error) {
			if (error instanceof SyntaxError) return;
			throw error;
		}
	} finally {
		clearTimeout(timeout);
	}
}
