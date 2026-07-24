import type { ExtensionAPI, ExtensionCommandContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import {
	formatNotification,
	lastAssistantMessage,
	questionSummaryFromInput,
	questionSummaryFromPromptEvent,
	terminalNotificationFromMessage,
} from "./message.js";
import { configPath, isConfigured, loadSettings, settingsDiagnostics } from "./settings.js";
import { sendTelegramMessage } from "./telegram.js";
import { bindTerminalObserver, installTerminalObserver, unbindTerminalObserver } from "./terminal-observer.js";

const ASK_USER_PROMPT_EVENT = "rpiv:ask-user:prompt";
const ASK_USER_TOOL_NAMES = new Set(["ask_user_question", "ask-user-question"]);

interface PendingQuestionNotification {
	cwd: string;
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
	let terminalObserverBound = false;
	const terminalObserverInstalled = installTerminalObserver();
	const pendingQuestionNotifications = new Map<string, PendingQuestionNotification>();

	const send = (status: "completed" | "error" | "waiting", summary: string, cwd = currentCwd): void => {
		const settings = loadSettings();
		if (!settings.enabled || !isConfigured(settings)) return;

		const message = formatNotification(cwd, status, summary);
		void sendTelegramMessage(settings, message).catch(() => {
			// Telegram delivery is deliberately best-effort and must not interrupt Pi.
		});
	};

	const notifyTerminal = (message: unknown): void => {
		const notification = terminalNotificationFromMessage(message, lastTaskSummary);
		if (notification) send(notification.status, notification.summary);
	};

	const clearQuestionFallbacks = (): void => {
		for (const pending of pendingQuestionNotifications.values()) clearTimeout(pending.timer);
		pendingQuestionNotifications.clear();
	};

	pi.on("session_start", (_event, ctx) => {
		currentCwd = ctx.cwd;
		if (!terminalObserverInstalled) return;
		bindTerminalObserver(ctx.sessionManager as object, notifyTerminal);
		terminalObserverBound = true;
	});

	pi.on("session_shutdown", (_event, ctx) => {
		clearQuestionFallbacks();
		lastTaskSummary = "";
		if (!terminalObserverInstalled) return;
		unbindTerminalObserver(ctx.sessionManager as object);
		terminalObserverBound = false;
	});

	pi.on("before_agent_start", (event, ctx) => {
		currentCwd = ctx.cwd;
		lastTaskSummary = event.prompt;
	});

	// The rpiv extension emits this immediately before opening its questionnaire
	// UI. It avoids notifying for invalid/no-UI calls and gives us the question.
	pi.events.on(ASK_USER_PROMPT_EVENT, (payload) => {
		const firstPending = pendingQuestionNotifications.entries().next().value as
			| [string, PendingQuestionNotification]
			| undefined;
		if (firstPending) {
			clearTimeout(firstPending[1].timer);
			pendingQuestionNotifications.delete(firstPending[0]);
		}
		send("waiting", questionSummaryFromPromptEvent(payload) || firstPending?.[1].summary || "等待用户回复", firstPending?.[1].cwd);
	});

	// Fallback for another extension that exposes the same tool name but not the
	// rpiv event. A zero-delay timer lets the rpiv event above take precedence.
	pi.on("tool_call", (event, ctx) => {
		currentCwd = ctx.cwd;
		if (!ctx.hasUI || !isAskUserQuestion(event)) return;

		const summary = questionSummaryFromInput(event.input) || "等待用户回复";
		const pending: PendingQuestionNotification = {
			cwd: ctx.cwd,
			summary,
			timer: setTimeout(() => {
				pendingQuestionNotifications.delete(event.toolCallId);
				send("waiting", summary, ctx.cwd);
			}, 0),
		};
		pendingQuestionNotifications.set(event.toolCallId, pending);
	});

	// Compatibility fallback for a future Pi version where the post-run hook is
	// unavailable. Current Pi versions use the more accurate hook above.
	pi.on("agent_end", (event, ctx) => {
		currentCwd = ctx.cwd;
		if (terminalObserverBound) return;
		const assistant = lastAssistantMessage(event.messages);
		if (assistant) notifyTerminal(assistant);
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
