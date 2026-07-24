export type NotificationStatus = "completed" | "error" | "waiting";

export interface TerminalNotification {
	status: Exclude<NotificationStatus, "waiting">;
	summary: string;
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

export function truncateSummary(text: string, maxCharacters = 30): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (!normalized) return "";

	const characters = Array.from(normalized);
	return characters.length > maxCharacters ? `${characters.slice(0, maxCharacters).join("")}…` : normalized;
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

export function lastAssistantMessage(messages: readonly unknown[]): unknown | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const candidate = asRecord(messages[index]);
		if (candidate?.role === "assistant") return candidate;
	}
	return undefined;
}

export function questionSummaryFromInput(input: unknown): string {
	const params = asRecord(input);
	if (!params) return "";

	if (typeof params.question === "string") return params.question;
	const questions = Array.isArray(params.questions) ? params.questions : [];
	const firstQuestion = asRecord(questions[0]);
	if (typeof firstQuestion?.question === "string") return firstQuestion.question;
	if (typeof firstQuestion?.prompt === "string") return firstQuestion.prompt;
	return "";
}

export function questionSummaryFromPromptEvent(payload: unknown): string {
	const event = asRecord(payload);
	const questions = Array.isArray(event?.questions) ? event.questions : [];
	const firstQuestion = asRecord(questions[0]);
	return typeof firstQuestion?.question === "string" ? firstQuestion.question : "";
}

export function formatNotification(cwd: string, status: NotificationStatus, summary: string): string {
	const project = cwd.trim() || "(未知项目目录)";
	const fallbackSummary = status === "completed" ? "Pi 任务已完成" : status === "error" ? "Pi 任务失败" : "等待用户回复";
	const body = truncateSummary(summary) || fallbackSummary;
	return [`项目: ${project}`, `状态: ${STATUS_LABEL[status]}`, `概要: ${body}`].join("\n");
}
