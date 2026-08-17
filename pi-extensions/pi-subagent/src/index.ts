import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadSettings } from "./config.ts";
import {
	REPORT_CUSTOM_TYPE,
	SETTLED_CUSTOM_TYPE,
	SubagentCoordinator,
	type DelegationInput,
} from "./coordinator.ts";
import { discoverAgents, formatAgentCatalog } from "./agents.ts";
import {
	DelegationParameters,
	ForkDelegationParameters,
	InterruptParameters,
	ListAgentsParameters,
	SendMessageParameters,
} from "./schemas.ts";
import { renderDelegationCall, renderDelegationResult, renderParentMessage } from "./render.ts";
import type { ControlDetails, DelegationDetails, ParentMessageDetails } from "./types.ts";

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(SOURCE_DIR);
const BUNDLED_AGENTS_DIR = join(PACKAGE_ROOT, "agents");

function textContent(content: Array<{ type: string; text?: string }>): string {
	return content.find((item) => item.type === "text")?.text ?? "";
}

export default function subagentExtension(pi: ExtensionAPI): void {
	const coordinator = new SubagentCoordinator(pi, BUNDLED_AGENTS_DIR, PACKAGE_ROOT);

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Delegate a complete standalone task to a fresh child with its own Pi session and context. " +
			"Background mode is continuable and returns a durable child id; use send_message for later FIFO turns. " +
			"Start independent children together in one assistant message.",
		promptSnippet: "Delegate focused independent work to fresh child agents",
		promptGuidelines: [
			"Use subagent for focused independent work and give it a complete standalone prompt.",
			"Call subagent multiple times in one assistant message when delegations are independent.",
			"Keep useful parent work moving after a background subagent starts; use foreground only when the next action needs its result.",
		],
		executionMode: "parallel",
		parameters: DelegationParameters,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const loaded = loadSettings({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
			const parent = await coordinator.parentFromContext(ctx);
			const outcome = await coordinator.delegate(
				parent,
				"spawn",
				params,
				loaded.settings,
				signal,
				(details) =>
					onUpdate?.({
						content: [{ type: "text", text: details.trace.at(-1)?.text ?? `${details.agent}: ${details.status}` }],
						details,
					}),
			);
			return coordinator.outcomeToolResult(outcome);
		},
		renderCall(args, theme) {
			return renderDelegationCall(args, theme, "spawn");
		},
		renderResult(result, options, theme) {
			return renderDelegationResult(
				result.details as DelegationDetails | undefined,
				textContent(result.content),
				options,
				theme,
			);
		},
	});

	pi.registerTool({
		name: "subagent_fork",
		label: "Subagent Fork",
		description:
			"Delegate a one-shot task to a child seeded with all completed turns in this conversation. " +
			"The current in-flight tool-calling turn is excluded. Use this when the child needs parent history.",
		promptSnippet: "Delegate context-dependent work to a child seeded with completed turns",
		promptGuidelines: [
			"Use subagent_fork only when completed conversation history materially helps the delegated task.",
		],
		executionMode: "parallel",
		parameters: ForkDelegationParameters,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const loaded = loadSettings({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
			const parent = await coordinator.parentFromContext(ctx);
			const outcome = await coordinator.delegate(
				parent,
				"fork",
				params satisfies DelegationInput,
				loaded.settings,
				signal,
				(details) =>
					onUpdate?.({
						content: [{ type: "text", text: details.trace.at(-1)?.text ?? `${details.agent}: ${details.status}` }],
						details,
					}),
			);
			return coordinator.outcomeToolResult(outcome);
		},
		renderCall(args, theme) {
			return renderDelegationCall(args, theme, "fork");
		},
		renderResult(result, options, theme) {
			return renderDelegationResult(
				result.details as DelegationDetails | undefined,
				textContent(result.content),
				options,
				theme,
			);
		},
	});

	pi.registerTool({
		name: "send_message",
		label: "Send Message",
		description:
			"Queue a message as a direct continuable child's next FIFO turn. If it is inactive, its persisted session is cold-resumed. " +
			"This call returns acceptance only, never the child's answer.",
		promptSnippet: "Send a later FIFO turn to a direct continuable subagent",
		executionMode: "parallel",
		parameters: SendMessageParameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const parent = await coordinator.parentFromContext(ctx);
			await coordinator.sendMessage(parent, params.subagent_id, params.message, signal);
			return {
				content: [
					{
						type: "text",
						text: `message queued as the next turn for subagent ${params.subagent_id}`,
					},
				],
				details: { kind: "control", action: "send", id: params.subagent_id } satisfies ControlDetails,
			};
		},
	});

	pi.registerTool({
		name: "interrupt_agent",
		label: "Interrupt Agent",
		description:
			"Request cancellation of a live child or descendant's current turn. The child session remains available for later messages. " +
			"An inactive or already-settled target is an accepted no-op.",
		promptSnippet: "Interrupt a live descendant's current turn without deleting its session",
		executionMode: "parallel",
		parameters: InterruptParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const parent = await coordinator.parentFromContext(ctx);
			await coordinator.interrupt(parent, params.agent_id);
			return {
				content: [{ type: "text", text: `interrupt requested for agent ${params.agent_id}` }],
				details: { kind: "control", action: "interrupt", id: params.agent_id } satisfies ControlDetails,
			};
		},
	});

	pi.registerTool({
		name: "list_agents",
		label: "List Agents",
		description:
			"List direct continuable children or all descendants. running means an active turn, idle means resident between turns, " +
			"and ready means persisted and cold-resumable.",
		promptSnippet: "List continuable child agents and their lifecycle status",
		parameters: ListAgentsParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const parent = await coordinator.parentFromContext(ctx);
			const scope = params.scope ?? "children";
			const entries = await coordinator.list(parent, scope);
			return {
				content: [{ type: "text", text: coordinator.formatCatalog(entries, scope) }],
				details: { kind: "control", action: "list" } satisfies ControlDetails,
			};
		},
	});

	for (const customType of [REPORT_CUSTOM_TYPE, SETTLED_CUSTOM_TYPE]) {
		pi.registerMessageRenderer<ParentMessageDetails>(customType, (message, options, theme) => {
			const content =
				typeof message.content === "string"
					? message.content
					: message.content
							.filter((item): item is Extract<(typeof message.content)[number], { type: "text" }> => item.type === "text")
							.map((item) => item.text)
							.join("");
			return renderParentMessage(content, message.details, options.expanded, options.outputPad, theme);
		});
	}

	pi.registerCommand("subagents", {
		description: "Show available agent definitions and continuable descendants",
		handler: async (_args, ctx) => {
			const loaded = loadSettings({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
			const discovery = discoverAgents({
				cwd: ctx.cwd,
				scope: loaded.settings.agentScope,
				projectTrusted: ctx.isProjectTrusted(),
				bundledDir: BUNDLED_AGENTS_DIR,
			});
			const parent = await coordinator.parentFromContext(ctx);
			const entries = await coordinator.list(parent, "descendants");
			const sections = [
				`Agents:\n${formatAgentCatalog(discovery.agents)}`,
				`Children:\n${coordinator.formatCatalog(entries, "descendants")}`,
			];
			if (discovery.diagnostics.length > 0) {
				sections.push(`Diagnostics:\n${discovery.diagnostics.join("\n")}`);
			}
			ctx.ui.notify(sections.join("\n\n"), "info");
		},
	});

	pi.on("session_shutdown", async () => {
		await coordinator.shutdown();
	});
}

export { SubagentCoordinator } from "./coordinator.ts";
export type { ChildProvider } from "./providers.ts";
