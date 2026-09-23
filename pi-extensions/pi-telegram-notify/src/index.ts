import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	formatNotification,
	isSubagentSession,
	lastAssistantMessageEntry,
	terminalNotificationFromMessage,
} from "./message.js";
import { configPath, isConfigured, loadSettings, settingsDiagnostics } from "./settings.js";
import { sendTelegramMessage } from "./telegram.js";

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
	let sessionContext: ExtensionContext | undefined;

	const send = (status: "completed" | "error" | "waiting", summary: string, cwd = currentCwd): void => {
		// Child descriptors can be appended after session_start.
		if (!sessionContext || isSubagentSession(sessionContext.sessionManager.getEntries())) return;
		const settings = loadSettings();
		if (!settings.enabled || !isConfigured(settings)) return;

		const message = formatNotification(cwd, status, summary);
		void sendTelegramMessage(settings, message).catch(() => {
			// Telegram delivery is deliberately best-effort and must not interrupt Pi.
		});
	};

	pi.on("session_start", (_event, ctx) => {
		sessionContext = ctx;
		currentCwd = ctx.cwd;
		lastTaskSummary = "";
		lastHandledAssistantEntryId = undefined;
	});

	pi.on("session_shutdown", () => {
		sessionContext = undefined;
		currentCwd = process.cwd();
		lastTaskSummary = "";
		lastHandledAssistantEntryId = undefined;
	});

	pi.on("before_agent_start", (event, ctx) => {
		currentCwd = ctx.cwd;
		lastTaskSummary = event.prompt;
	});

	pi.on("ui_prompt_start", (event, ctx) => {
		if (!ctx.hasUI) return;
		send("waiting", event.title?.trim() || "等待用户回复", ctx.cwd);
	});

	pi.on("agent_settled", (_event, ctx) => {
		currentCwd = ctx.cwd;
		if (isSubagentSession(ctx.sessionManager.getEntries())) return;
		const branch = ctx.sessionManager.getBranch();
		const assistantEntry = lastAssistantMessageEntry(branch);
		if (!assistantEntry || assistantEntry.id === lastHandledAssistantEntryId) return;
		lastHandledAssistantEntryId = assistantEntry.id;

		const notification = terminalNotificationFromMessage(assistantEntry.message, lastTaskSummary);
		if (notification) send(notification.status, notification.summary);
	});

	const sendTest = async (ctx: ExtensionCommandContext): Promise<void> => {
		if (isSubagentSession(ctx.sessionManager.getEntries())) {
			ctx.ui.notify("Telegram notifications are disabled in subagent sessions.", "info");
			return;
		}
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
