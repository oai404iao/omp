import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notificationSequence } from "./src/notification.ts";
import { configPath, isTelegramConfigured, loadSettings, notificationChannel } from "./src/settings.ts";
import { formatNotification, sendTelegramMessage, terminalNotificationFromMessage, type NotificationStatus } from "./src/telegram.ts";

function isSubagent(ctx: ExtensionContext): boolean {
	return ctx.sessionManager.getEntries().some(
		(entry) => entry.type === "custom" && entry.customType === "pi-subagent/descriptor",
	);
}

function notify(
	ctx: ExtensionContext,
	body: string,
	condition: "unfocused" | "always" = "unfocused",
): boolean {
	if (notificationChannel() === "telegram") return false;
	// Never emit terminal escape codes into RPC, JSON, print, or child output.
	if (ctx.mode !== "tui" || !process.stdout.isTTY) return false;
	if (isSubagent(ctx)) return false;

	const sequence = notificationSequence(process.env, `${basename(ctx.cwd) || ctx.cwd}: ${body}`, condition);
	if (!sequence) return false;
	try {
		process.stdout.write(sequence);
		return true;
	} catch {
		// Desktop notification delivery must not interrupt the agent.
		return false;
	}
}

export default function notifyExtension(pi: ExtensionAPI): void {
	let lastNotifiedEntryId: string | undefined;
	let lastTelegramEntryId: string | undefined;
	let userRunActive = false;
	let taskSummary = "";
	const reset = (): void => {
		lastNotifiedEntryId = undefined;
		lastTelegramEntryId = undefined;
		userRunActive = false;
		taskSummary = "";
	};
	pi.on("session_start", reset);
	pi.on("session_shutdown", reset);
	pi.on("before_agent_start", (event) => {
		userRunActive = event.messageType === "user";
		taskSummary = event.messageType === "user" ? event.prompt : "";
	});

	const sendTelegram = (ctx: ExtensionContext, status: NotificationStatus, summary: string): void => {
		if (isSubagent(ctx)) return;
		const settings = loadSettings();
		if (settings.channel === "local" || !settings.telegram.enabled || !isTelegramConfigured(settings.telegram)) return;
		void sendTelegramMessage(settings.telegram, formatNotification(ctx.cwd, status, summary)).catch(() => {
			// Network notification failures must not interrupt Pi or local delivery.
		});
	};
	pi.on("ui_prompt_start", (event, ctx) => {
		if (userRunActive && ctx.hasUI) sendTelegram(ctx, "waiting", event.title?.trim() || "等待用户回复");
	});

	// agent_end may still be followed by retries, compaction, or queued work.
	pi.on("agent_settled", (event, ctx) => {
		const notifyTelegramRun = userRunActive;
		const fallback = taskSummary;
		userRunActive = false;
		taskSummary = "";
		if (event.aborted) return;
		const entry = ctx.sessionManager.getBranch().findLast(
			(item) => item.type === "message" && item.message.role === "assistant",
		);
		if (!entry || entry.type !== "message" || entry.message.role !== "assistant") return;
		const reason = entry.message.stopReason;
		if (reason !== "stop" && reason !== "length" && reason !== "error") return;
		if (entry.id !== lastNotifiedEntryId && notify(ctx, reason === "error" ? "Stopped with an error" : "Ready for input")) {
			lastNotifiedEntryId = entry.id;
		}
		if (notifyTelegramRun && entry.id !== lastTelegramEntryId) {
			lastTelegramEntryId = entry.id;
			const notification = terminalNotificationFromMessage(entry.message, fallback);
			if (notification) sendTelegram(ctx, notification.status, notification.summary);
		}
	});

	pi.registerCommand("notify-test", {
		description: "Send a Kitty desktop notification, including when the terminal is focused",
		handler: async (_args, ctx) => {
			if (!notify(ctx, "Test notification", "always")) {
				ctx.ui.notify("Local notification not sent: requires the local channel and a Kitty TUI session with terminal output (not a subagent).", "warning");
			}
		},
	});
	pi.registerCommand("notify", {
		description: "Show notification configuration. Usage: /notify | /notify test telegram",
		handler: async (args, ctx) => {
			const settings = loadSettings();
			if (args.trim().toLowerCase() === "test telegram") {
				if (settings.channel === "local" || !settings.telegram.enabled || !isTelegramConfigured(settings.telegram) || isSubagent(ctx)) {
					ctx.ui.notify(`Telegram notification not sent: enable its channel and credentials in ${configPath()} (not a subagent).`, "warning");
					return;
				}
				try {
					await sendTelegramMessage(settings.telegram, formatNotification(ctx.cwd, "completed", "Telegram 通知测试"));
					ctx.ui.notify("Telegram test notification sent.", "info");
				} catch {
					ctx.ui.notify("Telegram test notification failed. Check credentials, chat permissions and network.", "error");
				}
				return;
			}
			if (args.trim()) {
				ctx.ui.notify("Usage: /notify | /notify test telegram", "warning");
				return;
			}
			ctx.ui.notify([
				`Notification channel: ${settings.channel}`, `config: ${configPath()}`,
				`Telegram enabled: ${settings.telegram.enabled}`,
				`bot token: ${settings.telegram.botToken ? "configured" : "missing"}`,
				`chat id: ${settings.telegram.chatId ? "configured" : "missing"}`,
				`request timeout: ${settings.telegram.requestTimeoutMs}ms`,
			].join("\n"), "info");
		},
	});
}
