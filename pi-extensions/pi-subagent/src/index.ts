import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS, loadSettings } from "./config.ts";
import {
	REPORT_CUSTOM_TYPE,
	SETTLED_CUSTOM_TYPE,
	SubagentCoordinator,
	type DelegationInput,
} from "./coordinator.ts";
import {
	formatAgentCatalog,
	type AgentDiscoveryResult,
} from "./agents.ts";
import {
	InterruptParameters,
	ListAgentsParameters,
	SendMessageParameters,
	delegationParameters,
	forkDelegationParameters,
} from "./schemas.ts";
import { renderDelegationCall, renderDelegationResult, renderParentMessage } from "./render.ts";
import type {
	ControlDetails,
	DelegationDetails,
	ParentMessageDetails,
	SubagentSettings,
} from "./types.ts";

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(SOURCE_DIR);
const BUNDLED_AGENTS_DIR = join(PACKAGE_ROOT, "agents");
const DELEGATION_TOOL_NAMES = ["subagent", "subagent_fork"] as const;
const DELEGATION_TOOL_NAME_SET = new Set<string>(DELEGATION_TOOL_NAMES);

function textContent(content: Array<{ type: string; text?: string }>): string {
	return content.find((item) => item.type === "text")?.text ?? "";
}

function disableEmptyDelegationTools(
	pi: ExtensionAPI,
	registeredParameters: ReadonlyMap<string, unknown>,
): void {
	const ownedNames = new Set(
		pi
			.getAllTools()
			.filter(
				(tool) =>
					DELEGATION_TOOL_NAME_SET.has(tool.name) &&
					tool.parameters === registeredParameters.get(tool.name),
			)
			.map((tool) => tool.name),
	);
	if (ownedNames.size === 0) return;
	const activeTools = pi.getActiveTools();
	const nextActiveTools = activeTools.filter((name) => !ownedNames.has(name));
	if (nextActiveTools.length !== activeTools.length) pi.setActiveTools(nextActiveTools);
}

function registerDelegationTool(
	pi: ExtensionAPI,
	coordinator: SubagentCoordinator,
	settings: SubagentSettings,
	agentDiscovery?: AgentDiscoveryResult,
): unknown {
	const { enableRunInBackground, defaultBackground } = settings;
	const agentNames = agentDiscovery?.agents.map((agent) => agent.name);
	const description = !enableRunInBackground
		? "Delegate a complete standalone task to a fresh child with its own Pi session and context. " +
			"This foreground-only tool waits for the child and returns its final answer. " +
			"Independent sibling calls may still execute in parallel."
		: defaultBackground
			? "Delegate a complete standalone task to a fresh child with its own Pi session and context. " +
				"Background mode is continuable and returns a durable child id; use send_message for later FIFO turns. " +
				"Start independent children together in one assistant message."
			: "Delegate a complete standalone task to a fresh child with its own Pi session and context. " +
				"This tool waits for the result by default; set run_in_background to true to return a durable child id.";
	const promptGuidelines = !enableRunInBackground
		? [
				"Use subagent for focused independent work and give it a complete standalone prompt.",
				"This subagent tool is foreground-only: every call waits for and returns the child's final answer.",
				"Independent subagent calls can still be issued together in one assistant message and execute in parallel.",
			]
		: defaultBackground
			? [
					"Use subagent for focused independent work and give it a complete standalone prompt.",
					"Call subagent multiple times in one assistant message when delegations are independent.",
					"Keep useful parent work moving after a background subagent starts; use foreground only when the next action needs its result.",
				]
			: [
					"Use subagent for focused independent work and give it a complete standalone prompt.",
					"Subagent calls wait for the result by default; request background mode only when work can continue independently.",
					"Independent subagent calls can still be issued together in one assistant message and execute in parallel.",
				];
	const parameters = delegationParameters(enableRunInBackground, agentNames);
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description,
		promptSnippet: enableRunInBackground
			? "Delegate focused independent work to fresh child agents"
			: "Run focused independent work in foreground child agents",
		promptGuidelines,
		executionMode: "parallel",
		parameters,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const parent = await coordinator.parentFromContext(ctx);
			const outcome = await coordinator.delegate(
				parent,
				"spawn",
				params,
				settings,
				signal,
				(details) =>
					onUpdate?.({
						content: [{ type: "text", text: details.trace.at(-1)?.text ?? `${details.agent}: ${details.status}` }],
						details,
					}),
				agentDiscovery,
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
	return parameters;
}

function registerForkDelegationTool(
	pi: ExtensionAPI,
	coordinator: SubagentCoordinator,
	settings: SubagentSettings,
	agentDiscovery?: AgentDiscoveryResult,
): unknown {
	const agentNames = agentDiscovery?.agents.map((agent) => agent.name);
	const parameters = forkDelegationParameters(agentNames);
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
		parameters,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const parent = await coordinator.parentFromContext(ctx);
			const outcome = await coordinator.delegate(
				parent,
				"fork",
				params satisfies DelegationInput,
				settings,
				signal,
				(details) =>
					onUpdate?.({
						content: [{ type: "text", text: details.trace.at(-1)?.text ?? `${details.agent}: ${details.status}` }],
						details,
					}),
				agentDiscovery,
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
	return parameters;
}

export default function subagentExtension(pi: ExtensionAPI): void {
	const coordinator = new SubagentCoordinator(pi, BUNDLED_AGENTS_DIR, PACKAGE_ROOT);
	const agentSync = coordinator.getAgentSyncResult();
	let agentSyncNotified = false;
	let sessionSettings: SubagentSettings = DEFAULT_SETTINGS;
	let sessionDiscovery: AgentDiscoveryResult | undefined;

	registerDelegationTool(pi, coordinator, DEFAULT_SETTINGS);
	registerForkDelegationTool(pi, coordinator, DEFAULT_SETTINGS);

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
			const discovery =
				sessionDiscovery ??
				coordinator.discoverAvailableAgents(
					ctx.cwd,
					sessionSettings.agentScope,
					ctx.isProjectTrusted(),
				);
			const parent = await coordinator.parentFromContext(ctx);
			const entries = await coordinator.list(parent, "descendants");
			const schedulingMode = !sessionSettings.enableRunInBackground
				? "foreground-only"
				: sessionSettings.defaultBackground
					? "background-first"
					: "foreground-first";
			const sections = [
				`Mode: ${schedulingMode}`,
				`Agent config: ${agentSync.userAgentsDir}`,
				`Agents:\n${formatAgentCatalog(discovery.agents)}`,
				`Children:\n${coordinator.formatCatalog(entries, "descendants")}`,
			];
			if (discovery.diagnostics.length > 0) {
				sections.push(`Diagnostics:\n${discovery.diagnostics.join("\n")}`);
			}
			ctx.ui.notify(sections.join("\n\n"), "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const loaded = loadSettings({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
		sessionSettings = loaded.settings;
		sessionDiscovery = coordinator.discoverAvailableAgents(
			ctx.cwd,
			sessionSettings.agentScope,
			ctx.isProjectTrusted(),
		);
		const registeredParameters = new Map<string, unknown>([
			[
				"subagent",
				registerDelegationTool(pi, coordinator, sessionSettings, sessionDiscovery),
			],
			[
				"subagent_fork",
				registerForkDelegationTool(pi, coordinator, sessionSettings, sessionDiscovery),
			],
		]);
		if (sessionDiscovery.agents.length === 0) {
			disableEmptyDelegationTools(pi, registeredParameters);
		}
		if (!agentSyncNotified) {
			agentSyncNotified = true;
			const lines = [`pi-subagent agent config: ${agentSync.userAgentsDir}`];
			if (agentSync.installed.length > 0) {
				lines.push(`installed: ${agentSync.installed.join(", ")}`);
			}
			if (agentSync.updated.length > 0) {
				lines.push(`updated: ${agentSync.updated.join(", ")}`);
			}
			if (agentSync.removed.length > 0) {
				lines.push(`retired: ${agentSync.removed.join(", ")}`);
			}
			if (agentSync.backups.length > 0) {
				lines.push("backups:", ...agentSync.backups.map((backup) => `- ${backup.name}: ${backup.path}`));
			}
			if (
				agentSync.installed.length > 0 ||
				agentSync.updated.length > 0 ||
				agentSync.removed.length > 0 ||
				agentSync.backups.length > 0
			) {
				ctx.ui.notify(lines.join("\n"), "info");
			}
			if (agentSync.diagnostics.length > 0) {
				ctx.ui.notify(agentSync.diagnostics.join("\n"), "warning");
			}
		}
	});

	pi.on("session_shutdown", async () => {
		await coordinator.shutdown();
	});
}

export { SubagentCoordinator } from "./coordinator.ts";
export type { ChildProvider } from "./providers.ts";
