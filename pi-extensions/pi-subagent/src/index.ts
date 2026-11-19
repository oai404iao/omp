import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type SessionManager } from "@earendil-works/pi-coding-agent";
import { loadSettings } from "./config.ts";
import { SubagentCoordinator } from "./coordinator.ts";
import { formatAgentCatalog } from "./agents.ts";
import { createAgentTools } from "./tools.ts";
import { MESSAGE_CUSTOM_TYPE } from "./store.ts";
import { renderAgentMessage } from "./render.ts";
import { openDashboard } from "./dashboard.ts";
import { independentTreeContext } from "./tree-context.ts";
import { loadCodexIntegration } from "./codex-integration.ts";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MAIL_WAKE_CUSTOM_TYPE = "pi-subagent/mail-wake";

export default async function subagentExtension(pi: ExtensionAPI, options: {
	agentDir?: string;
	loadCodexIntegration?: typeof loadCodexIntegration;
} = {}): Promise<void> {
	const codexIntegration = await (options.loadCodexIntegration ?? loadCodexIntegration)();
	let coordinator: SubagentCoordinator | undefined;
	let initializationError: unknown;
	let dashboardOpen = false;
	let skippedMailWake = false;
	let wakeScope: string | undefined;
	const current = () => {
		if (!coordinator) throw new Error("pi-subagent is not initialized", { cause: initializationError });
		return coordinator;
	};
	const register = (agents: Parameters<typeof createAgentTools>[2]) => {
		for (const tool of createAgentTools(current, ctx => current().rootCaller(ctx), agents)) pi.registerTool(tool);
	};
	register([]);

	const initialize = async (ctx: ExtensionContext) => {
		await coordinator?.shutdown();
		coordinator = undefined;
		wakeScope = undefined;
		try {
			const agentDir = options.agentDir ?? getAgentDir();
			const { settings } = loadSettings({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted(), agentDir });
			const scope = randomUUID();
			const controller = new SubagentCoordinator(pi, PACKAGE_ROOT, codexIntegration, settings, agentDir, () => {
				if (!ctx.isIdle()) return false;
				pi.sendMessage({
					customType: MAIL_WAKE_CUSTOM_TYPE, content: "Process the new agent messages below.", display: false,
					details: { scope },
				}, { triggerTurn: true });
				return true;
			});
			const root = controller.attachRoot(ctx);
			const catalog = controller.catalog(root);
			coordinator = controller;
			wakeScope = scope;
			register(catalog.agents);
			if (catalog.diagnostics.length) ctx.ui.notify(catalog.diagnostics.join("\n"), "warning");
			initializationError = undefined;
		} catch (error) {
			initializationError = error;
			throw error;
		}
	};
	pi.on("session_start", (_event, ctx) => initialize(ctx));
	pi.on("session_tree", (_event, ctx) => initialize(ctx));
	pi.on("session_shutdown", async () => { await coordinator?.shutdown(); });
	pi.on("before_agent_start", (event, ctx) => {
		const mailWake = event.messageType === "custom" && event.message.customType === MAIL_WAKE_CUSTOM_TYPE;
		const session = ctx.sessionManager as SessionManager;
		const scope = mailWake ? (event.message.details as { scope?: string } | undefined)?.scope : undefined;
		const wakeMessage = scope && scope === wakeScope ? coordinator?.inboxMessage("/root", session) : undefined;
		// Pi can defer a custom trigger until after another queued prompt has already read the inbox.
		skippedMailWake = mailWake && !wakeMessage;
		if (skippedMailWake) { ctx.abort(); return; }
		if (!coordinator) return;
		coordinator.rootCaller(ctx);
		const message = wakeMessage ?? coordinator.inboxMessage("/root", session);
		const treeContext = independentTreeContext(session);
		if (treeContext) event.systemPromptOptions.sections.subagent_tree = treeContext;
		return message ? { message } : undefined;
	});
	pi.on("turn_end", (event, ctx) =>
		coordinator?.boundary("/root", ctx.sessionManager as SessionManager, event.outcome, false));
	pi.on("agent_before_settle", (event, ctx) =>
		coordinator?.boundary("/root", ctx.sessionManager as SessionManager, event.outcome, true));
	pi.on("turn_start", (_event, ctx) => coordinator?.reconcile("/root", ctx.sessionManager as SessionManager));
	pi.on("input", () => { coordinator?.notifyInput("/root"); return { action: "continue" as const }; });
	pi.on("agent_start", () => coordinator?.setRootRunning(true));
	pi.on("agent_settled", (event, ctx) => {
		try { coordinator?.reconcile("/root", ctx.sessionManager as SessionManager); }
		finally {
			coordinator?.setRootRunning(false, event.aborted && !skippedMailWake);
			skippedMailWake = false;
		}
	});
	pi.registerMessageRenderer(MESSAGE_CUSTOM_TYPE, (message, options, theme) => {
		const content = typeof message.content === "string" ? message.content :
			message.content.filter(item => item.type === "text").map(item => item.text).join("");
		return renderAgentMessage(content, options.expanded, theme);
	});
	pi.registerCommand("subagents", {
		description: "Open the current session's subagent dashboard (catalog: show agent definitions)",
		handler: async (args, ctx) => {
			const controller = current();
			const caller = controller.rootCaller(ctx);
			if (args.trim() && args.trim() !== "catalog") {
				ctx.ui.notify("Usage: /subagents [catalog]", "warning");
				return;
			}
			if (!args.trim() && ctx.mode === "tui") {
				if (dashboardOpen) return;
				dashboardOpen = true;
				try { await openDashboard(ctx, controller); }
				finally { dashboardOpen = false; }
				return;
			}
			const catalog = controller.catalog(caller);
			ctx.ui.notify([
				`Active child runs: ${controller.activeCount}/${controller.settings.maxConcurrentAgents}`,
				`Agent definitions: ${controller.getUserAgentsDir()}`,
				formatAgentCatalog(catalog.agents),
				controller.list(caller).agents.map(agent =>
					`${agent.agent_name} [${agent.agent_status}; ${agent.lifecycle}] · Selected: ${agent.model} / ${agent.thinking}`).join("\n"),
				...catalog.diagnostics,
			].join("\n\n"), "info");
		},
	});
}

export { SubagentCoordinator } from "./coordinator.ts";
