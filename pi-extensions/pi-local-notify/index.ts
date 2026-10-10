import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notificationSequence } from "./src/notification.ts";

function notify(
	ctx: ExtensionContext,
	body: string,
	condition: "unfocused" | "always" = "unfocused",
): boolean {
	// Never emit terminal escape codes into RPC, JSON, print, or child output.
	if (ctx.mode !== "tui" || !process.stdout.isTTY) return false;
	if (ctx.sessionManager.getEntries().some(
		(entry) => entry.type === "custom" && entry.customType === "pi-subagent/descriptor",
	)) return false;

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

export default function localNotifyExtension(pi: ExtensionAPI): void {
	let lastNotifiedEntryId: string | undefined;
	pi.on("session_start", () => { lastNotifiedEntryId = undefined; });
	pi.on("session_shutdown", () => { lastNotifiedEntryId = undefined; });

	// agent_end may still be followed by retries, compaction, or queued work.
	pi.on("agent_settled", (_event, ctx) => {
		const entry = ctx.sessionManager.getBranch().findLast(
			(item) => item.type === "message" && item.message.role === "assistant",
		);
		if (!entry || entry.type !== "message" || entry.message.role !== "assistant") return;
		if (entry.id === lastNotifiedEntryId) return;
		const reason = entry.message.stopReason;
		if (reason !== "stop" && reason !== "length" && reason !== "error") return;
		if (notify(ctx, reason === "error" ? "Stopped with an error" : "Ready for input")) {
			lastNotifiedEntryId = entry.id;
		}
	});

	pi.registerCommand("local-notify-test", {
		description: "Send a Kitty desktop notification, including when the terminal is focused",
		handler: async (_args, ctx) => {
			if (!notify(ctx, "Test notification", "always")) {
				ctx.ui.notify("Local notification not sent: requires a Kitty TUI session with terminal output (not a subagent).", "warning");
			}
		},
	});
}
