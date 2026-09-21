import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export type NotificationStatus = "completed" | "error" | "waiting";

export interface TerminalNotification {
	status: Exclude<NotificationStatus, "waiting">;
	summary: string;
}

export interface AssistantMessageEntry {
	id: string;
	message: unknown;
}

const STATUS_LABEL: Record<NotificationStatus, string> = {
	completed: "完成",
	error: "错误",
	waiting: "等待回复",
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.map((part) => {
			const block = asRecord(part);
			return block?.type === "text" && typeof block.text === "string" ? block.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

// UTF-16 budgets conservatively fit Telegram's 4096-character parsed-text limit,
// including the project path and labels. Truncate before adding Markdown escapes.
const SUMMARY_LIMIT = 3000;
const PROJECT_LIMIT = 512;

export function truncateSummary(text: string, maxCharacters = SUMMARY_LIMIT): string {
	const normalized = text.replace(/\r\n?/g, "\n").trim();
	if (!normalized) return "";
	if (maxCharacters <= 0) return "";
	if (normalized.length <= maxCharacters) return normalized;

	let prefix = "";
	for (const character of normalized) {
		if (prefix.length + character.length > maxCharacters - 1) break;
		prefix += character;
	}
	// Prefer a paragraph, line, or word boundary near the limit without throwing
	// away most of the preview when the text has few separators (e.g. Chinese).
	for (const separator of ["\n\n", "\n", " "]) {
		const boundary = prefix.lastIndexOf(separator);
		if (boundary >= prefix.length * 0.8) {
			prefix = prefix.slice(0, boundary);
			break;
		}
	}
	return `${prefix.trimEnd()}…`;
}

function escapeMarkdown(text: string): string {
	return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

function escapeCode(text: string): string {
	return text.replace(/[`\\]/g, "\\$&");
}

export function isSubagentSession(entries: readonly SessionEntry[]): boolean {
	// pi-subagent persists this marker for both spawn and fork children. Do not
	// use hasUI or parentSession: normal print/RPC and user forks also use those.
	// Inspect all entries: navigating before the marker does not change identity.
	return entries.some((entry) => entry.type === "custom" && entry.customType === "pi-subagent/descriptor");
}

export function terminalNotificationFromMessage(message: unknown, fallbackSummary = ""): TerminalNotification | undefined {
	const assistant = asRecord(message);
	if (assistant?.role !== "assistant") return undefined;

	const stopReason = assistant.stopReason;
	const text = textFromContent(assistant.content);
	if (stopReason === "error") {
		const errorMessage = typeof assistant.errorMessage === "string" ? assistant.errorMessage : "";
		return {
			status: "error",
			summary: errorMessage || text || fallbackSummary || "Pi 任务失败",
		};
	}

	if (stopReason === "stop") {
		return {
			status: "completed",
			summary: text || fallbackSummary || "Pi 任务已完成",
		};
	}

	if (stopReason === "length") {
		return {
			status: "completed",
			summary: text || "模型输出达到长度上限",
		};
	}

	return undefined;
}

export function lastAssistantMessageEntry(entries: readonly SessionEntry[]): AssistantMessageEntry | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type === "message" && entry.message.role === "assistant") {
			return { id: entry.id, message: entry.message };
		}
	}
	return undefined;
}

export function formatNotification(cwd: string, status: NotificationStatus, summary: string): string {
	const project = truncateSummary(cwd.replace(/\s+/g, " "), PROJECT_LIMIT) || "(未知项目目录)";
	const fallbackSummary = status === "completed" ? "Pi 任务已完成" : status === "error" ? "Pi 任务失败" : "等待用户回复";
	const body = truncateSummary(summary) || fallbackSummary;
	return [
		`*项目:* \`${escapeCode(project)}\``,
		`*状态:* ${STATUS_LABEL[status]}`,
		"",
		"*概要:*",
		escapeMarkdown(body),
	].join("\n");
}
