import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { loadSettings } from "./config.ts";
import { SubagentCoordinator } from "./coordinator.ts";
import { formatAgentCatalog } from "./agents.ts";
import { createAgentTools } from "./tools.ts";
import { MESSAGE_CUSTOM_TYPE } from "./store.ts";
import { renderAgentMessage } from "./render.ts";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export default function subagentExtension(pi: ExtensionAPI): void {
	let coordinator: SubagentCoordinator | undefined;
	let initializationError: unknown;
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
		try {
			const { settings } = loadSettings({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
			const controller = new SubagentCoordinator(pi, PACKAGE_ROOT, settings);
			const root = controller.attachRoot(ctx);
			const catalog = controller.catalog(root);
			coordinator = controller;
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
	pi.on("before_agent_start", (_event, ctx) => {
		if (!coordinator) return;
		coordinator.rootCaller(ctx);
		const message = coordinator.inboxMessage("/root", ctx.sessionManager as SessionManager);
		return message ? { message } : undefined;
	});
	pi.on("turn_end", (event, ctx) =>
		coordinator?.boundary("/root", ctx.sessionManager as SessionManager, event.outcome, false));
	pi.on("agent_before_settle", (event, ctx) =>
		coordinator?.boundary("/root", ctx.sessionManager as SessionManager, event.outcome, true));
	pi.on("turn_start", (_event, ctx) => coordinator?.reconcile("/root", ctx.sessionManager as SessionManager));
	pi.on("input", () => { coordinator?.notifyInput("/root"); return { action: "continue" as const }; });
	pi.on("agent_start", () => coordinator?.setRootRunning(true));
	pi.on("agent_settled", (_event, ctx) => {
		coordinator?.reconcile("/root", ctx.sessionManager as SessionManager);
		coordinator?.setRootRunning(false);
	});
	pi.registerMessageRenderer(MESSAGE_CUSTOM_TYPE, (message, options, theme) => {
		const content = typeof message.content === "string" ? message.content :
			message.content.filter(item => item.type === "text").map(item => item.text).join("");
		return renderAgentMessage(content, options.expanded, theme);
	});
	pi.registerCommand("subagents", {
		description: "Show the agent catalog and current root tree",
		handler: async (_args, ctx) => {
			const controller = current();
			const caller = controller.rootCaller(ctx);
			const catalog = controller.catalog(caller);
			ctx.ui.notify([
				`Active child runs: ${controller.activeCount}/${controller.settings.maxConcurrentAgents}`,
				`Agent definitions: ${controller.getUserAgentsDir()}`,
				formatAgentCatalog(catalog.agents),
				controller.list(caller).agents.map(agent => `${agent.agent_name} [${agent.agent_status}]`).join("\n"),
				...catalog.diagnostics,
			].join("\n\n"), "info");
		},
	});
}

export { SubagentCoordinator } from "./coordinator.ts";
