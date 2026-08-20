import type { ExtensionAPI, ExtensionCommandContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import {
	formatNotification,
	lastAssistantMessageEntry,
	questionSummaryFromInput,
	questionSummaryFromPromptEvent,
	terminalNotificationFromMessage,
} from "./message.js";
import { configPath, isConfigured, loadSettings, settingsDiagnostics } from "./settings.js";
import { sendTelegramMessage } from "./telegram.js";

const ASK_USER_PROMPT_EVENT = "rpiv:ask-user:prompt";
const ASK_USER_FALLBACK_GRACE_MS = 100;
const ASK_USER_TOOL_NAMES = new Set(["ask_user_question", "ask-user-question"]);

interface PendingQuestionNotification {
	cwd: string;
	notified: boolean;
	summary: string;
	timer: NodeJS.Timeout;
}

function isAskUserQuestion(event: ToolCallEvent): boolean {
	return ASK_USER_TOOL_NAMES.has(event.toolName);
}

function notifyConfigurationStatus(ctx: ExtensionCommandContext): void {
	const settings = loadSettings();
	const diagnostics = settingsDiagnostics();
	const lines = [
		"Telegram Notify",
		`config: ${configPath()}`,
		`enabled: ${settings.enabled}`,
		`bot token: ${settings.botToken ? "configured" : "missing"}`,
		`chat id: ${settings.chatId ? "configured" : "missing"}`,
		`request timeout: ${settings.requestTimeoutMs}ms`,
	];
	if (diagnostics.length > 0) lines.push("diagnostics:", ...diagnostics.map((diagnostic) => `- ${diagnostic}`));
	ctx.ui.notify(lines.join("\n"), isConfigured(settings) ? "info" : "warning");
}

export default function telegramNotifyExtension(pi: ExtensionAPI): void {
	let currentCwd = process.cwd();
	let lastTaskSummary = "";
	let lastHandledAssistantEntryId: string | undefined;
	let unsubscribeAskUserPrompt: (() => void) | undefined;
	const pendingQuestionNotifications = new Map<string, PendingQuestionNotification>();

	const send = (status: "completed" | "error" | "waiting", summary: string, cwd = currentCwd): void => {
		const settings = loadSettings();
		if (!settings.enabled || !isConfigured(settings)) return;

		const message = formatNotification(cwd, status, summary);
		void sendTelegramMessage(settings, message).catch(() => {
			// Telegram delivery is deliberately best-effort and must not interrupt Pi.
		});
	};

	const clearQuestionFallbacks = (): void => {
		for (const pending of pendingQuestionNotifications.values()) clearTimeout(pending.timer);
		pendingQuestionNotifications.clear();
	};

	const clearQuestionFallback = (toolCallId: string): void => {
		const pending = pendingQuestionNotifications.get(toolCallId);
		if (!pending) return;
		clearTimeout(pending.timer);
		pendingQuestionNotifications.delete(toolCallId);
	};

	const takeQuestionFallback = (summary: string): PendingQuestionNotification | undefined => {
		let toolCallId: string | undefined;
		if (summary) {
			for (const [pendingToolCallId, pending] of pendingQuestionNotifications) {
				if (pending.summary === summary) {
					toolCallId = pendingToolCallId;
					break;
				}
			}
		}
		toolCallId ??= pendingQuestionNotifications.keys().next().value;
		if (toolCallId === undefined) return undefined;

		const pending = pendingQuestionNotifications.get(toolCallId);
		if (!pending) return undefined;
		clearTimeout(pending.timer);
		pendingQuestionNotifications.delete(toolCallId);
		return pending;
	};

	const unsubscribeAskUserPromptEvent = (): void => {
		unsubscribeAskUserPrompt?.();
		unsubscribeAskUserPrompt = undefined;
	};

	pi.on("session_start", (_event, ctx) => {
		clearQuestionFallbacks();
		unsubscribeAskUserPromptEvent();
		currentCwd = ctx.cwd;
		lastTaskSummary = "";
		lastHandledAssistantEntryId = undefined;

		// rpiv emits this immediately before opening its questionnaire UI. Match
		// its question to one fallback, or consume the oldest call when it cannot
		// be matched, without disturbing concurrent questionnaires.
		unsubscribeAskUserPrompt = pi.events.on(ASK_USER_PROMPT_EVENT, (payload) => {
			const summary = questionSummaryFromPromptEvent(payload);
			const pending = takeQuestionFallback(summary);
			if (pending?.notified) return;
			send(
				"waiting",
				summary || pending?.summary || "等待用户回复",
				pending?.cwd ?? currentCwd,
			);
		});
	});

	pi.on("session_shutdown", () => {
		clearQuestionFallbacks();
		unsubscribeAskUserPromptEvent();
		currentCwd = process.cwd();
		lastTaskSummary = "";
		lastHandledAssistantEntryId = undefined;
	});

	pi.on("before_agent_start", (event, ctx) => {
		currentCwd = ctx.cwd;
		lastTaskSummary = event.prompt;
	});

	// Fallback for another extension that exposes the same tool name but not the
	// rpiv event. A short grace period lets the authoritative event win.
	pi.on("tool_call", (event, ctx) => {
		currentCwd = ctx.cwd;
		if (!ctx.hasUI || !isAskUserQuestion(event)) return;

		clearQuestionFallback(event.toolCallId);
		const summary = questionSummaryFromInput(event.input) || "等待用户回复";
		let timer: NodeJS.Timeout;
		const pending: PendingQuestionNotification = {
			cwd: ctx.cwd,
			notified: false,
			summary,
			timer: timer = setTimeout(() => {
				const current = pendingQuestionNotifications.get(event.toolCallId);
				if (current?.timer !== timer || current.notified) return;
				current.notified = true;
				send("waiting", summary, ctx.cwd);
			}, ASK_USER_FALLBACK_GRACE_MS),
		};
		timer.unref?.();
		pendingQuestionNotifications.set(event.toolCallId, pending);
	});

	pi.on("tool_result", (event) => {
		clearQuestionFallback(event.toolCallId);
	});

	pi.on("agent_settled", (_event, ctx) => {
		currentCwd = ctx.cwd;
		const assistantEntry = lastAssistantMessageEntry(ctx.sessionManager.getBranch());
		if (!assistantEntry || assistantEntry.id === lastHandledAssistantEntryId) return;
		lastHandledAssistantEntryId = assistantEntry.id;

		const notification = terminalNotificationFromMessage(assistantEntry.message, lastTaskSummary);
		if (notification) send(notification.status, notification.summary);
	});

	const sendTest = async (ctx: ExtensionCommandContext): Promise<void> => {
		const settings = loadSettings();
		if (!settings.enabled || !isConfigured(settings)) {
			ctx.ui.notify(`Telegram Notify is not configured. Edit ${configPath()}`, "warning");
			return;
		}
		try {
			await sendTelegramMessage(settings, formatNotification(ctx.cwd, "completed", "Telegram 通知测试"));
			ctx.ui.notify("Telegram test notification sent.", "info");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Telegram test notification failed: ${message}`, "error");
		}
	};

	pi.registerCommand("telegram-notify", {
		description: "Show Telegram notification status. Usage: /telegram-notify | /telegram-notify test",
		handler: async (args, ctx) => {
			currentCwd = ctx.cwd;
			const subcommand = args.trim().toLowerCase();
			if (!subcommand) {
				notifyConfigurationStatus(ctx);
				return;
			}
			if (subcommand === "test") {
				await sendTest(ctx);
				return;
			}
			ctx.ui.notify("Usage: /telegram-notify | /telegram-notify test", "warning");
		},
	});

	pi.registerCommand("telegram-notify:test", {
		description: "Send a Telegram test notification",
		handler: async (_args, ctx) => {
			currentCwd = ctx.cwd;
			await sendTest(ctx);
		},
	});
}
