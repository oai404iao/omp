import type { ConfiguredTelegramSettings } from "./settings.ts";

export type NotificationStatus = "completed" | "error" | "waiting";

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(part => {
		const block = asRecord(part);
		return block?.type === "text" && typeof block.text === "string" ? block.text : "";
	}).filter(Boolean).join("\n");
}

// Truncate before Markdown escaping and preserve whole Unicode code points.
export function truncateSummary(text: string, maxCharacters = 3000): string {
	const normalized = text.replace(/\r\n?/g, "\n").trim();
	if (!normalized || maxCharacters <= 0) return "";
	if (normalized.length <= maxCharacters) return normalized;
	let prefix = "";
	for (const character of normalized) {
		if (prefix.length + character.length > maxCharacters - 1) break;
		prefix += character;
	}
	for (const separator of ["\n\n", "\n", " "]) {
		const boundary = prefix.lastIndexOf(separator);
		if (boundary >= prefix.length * 0.8) {
			prefix = prefix.slice(0, boundary);
			break;
		}
	}
	return `${prefix.trimEnd()}…`;
}

export function terminalNotificationFromMessage(message: unknown, fallbackSummary = ""): {
	status: "completed" | "error";
	summary: string;
} | undefined {
	const assistant = asRecord(message);
	if (assistant?.role !== "assistant") return undefined;
	const text = textFromContent(assistant.content);
	if (assistant.stopReason === "error") {
		const error = typeof assistant.errorMessage === "string" ? assistant.errorMessage : "";
		return { status: "error", summary: error || text || fallbackSummary || "Pi 任务失败" };
	}
	if (assistant.stopReason === "stop") return { status: "completed", summary: text || fallbackSummary || "Pi 任务已完成" };
	if (assistant.stopReason === "length") return { status: "completed", summary: text || "模型输出达到长度上限" };
	return undefined;
}

export function formatNotification(cwd: string, status: NotificationStatus, summary: string): string {
	const project = truncateSummary(cwd.replace(/\s+/g, " "), 512) || "(未知项目目录)";
	const label = { completed: "完成", error: "错误", waiting: "等待回复" }[status];
	const fallback = status === "completed" ? "Pi 任务已完成" : status === "error" ? "Pi 任务失败" : "等待用户回复";
	const body = truncateSummary(summary) || fallback;
	return [
		`*项目:* \`${project.replace(/[`\\]/g, "\\$&")}\``,
		`*状态:* ${label}`,
		"", "*概要:*", body.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&"),
	].join("\n");
}

export interface TelegramResponse {
	ok: boolean;
	status: number;
	text(): Promise<string>;
}

export type TelegramFetch = (url: string, init: {
	method: string;
	headers: Record<string, string>;
	body: string;
	signal: AbortSignal;
}) => Promise<TelegramResponse>;

export function telegramEndpoint(botToken: string): string {
	return `https://api.telegram.org/bot${encodeURIComponent(botToken)}/sendMessage`;
}

export async function sendTelegramMessage(
	settings: ConfiguredTelegramSettings,
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
			body: JSON.stringify({ chat_id: settings.chatId, text, parse_mode: "MarkdownV2", disable_web_page_preview: true }),
			signal: controller.signal,
		});
		const body = await response.text();
		if (!response.ok) throw new Error(`Telegram request failed (${response.status})`);
		try {
			const payload = JSON.parse(body) as { ok?: unknown };
			if (payload.ok === false) throw new Error("Telegram request was rejected");
		} catch (error) {
			if (!(error instanceof SyntaxError)) throw error;
		}
	} finally {
		clearTimeout(timeout);
	}
}
