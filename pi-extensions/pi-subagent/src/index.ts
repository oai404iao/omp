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
import type { AgentSyncResult } from "./agent-sync.ts";
import {
	FollowupTaskParameters,
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

function textContent(content: Array<{ type: string; text?: string }>): string {
	return content.find((item) => item.type === "text")?.text ?? "";
}

function disableOwnedTools(
	pi: ExtensionAPI,
	registeredParameters: ReadonlyMap<string, unknown>,
): void {
	const ownedNames = new Set(
		pi
			.getAllTools()
			.filter(
				(tool) =>
					registeredParameters.has(tool.name) &&
					tool.parameters === registeredParameters.get(tool.name) &&
					tool.sourceInfo.source !== "sdk",
			)
			.map((tool) => tool.name),
	);
	if (ownedNames.size === 0) return;
	const activeTools = pi.getActiveTools();
	const nextActiveTools = activeTools.filter((name) => !ownedNames.has(name));
	if (nextActiveTools.length !== activeTools.length) pi.setActiveTools(nextActiveTools);
}

function assertBackgroundControlsEnabled(settings: SubagentSettings, toolName: string): void {
	if (!settings.enableRunInBackground) {
		throw new Error(
			`tool "${toolName}" is unavailable in foreground-only mode (enableRunInBackground: false)`,
		);
	}
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
			(settings.backgroundProtocol === "mailbox-v2"
				? "Background mode is continuable and returns a durable agent id; use send_message to enqueue, then followup_task to start a later turn. "
				: "Background mode is continuable and returns a durable agent id; use send_message for later FIFO turns. ") +
			"Start independent children together in one assistant message."
		: "Delegate a complete standalone task to a fresh child with its own Pi session and context. " +
			"This tool waits for the result by default; set run_in_background to true to return a durable agent id.";
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
	let agentSyncNotified = false;
	let agentSync: AgentSyncResult | undefined;
	let sessionSettings: SubagentSettings = DEFAULT_SETTINGS;
	let sessionDiscovery: AgentDiscoveryResult | undefined;

	registerDelegationTool(pi, coordinator, DEFAULT_SETTINGS);
	registerForkDelegationTool(pi, coordinator, DEFAULT_SETTINGS);
	const backgroundControlParameters = new Map<string, unknown>([
		["send_message", SendMessageParameters],
		["followup_task", FollowupTaskParameters],
		["interrupt_agent", InterruptParameters],
		["list_agents", ListAgentsParameters],
	]);

	pi.registerTool({
		name: "send_message",
		label: "Send Message",
		description:
			"Send a message to a direct continuable child. Legacy children start or join a FIFO turn; mailbox-v2 children only durably enqueue it and require followup_task to execute. " +
			"This call returns acceptance only, never the child's answer.",
		promptSnippet: "Send or enqueue a message for a direct continuable subagent",
		executionMode: "parallel",
		parameters: SendMessageParameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			assertBackgroundControlsEnabled(sessionSettings, "send_message");
			const parent = await coordinator.parentFromContext(ctx);
			const delivery = await coordinator.sendMessageWithOutcome(
				parent,
				params.subagent_id,
				params.message,
				signal,
			);
			return {
				content: [
					{
						type: "text",
						text:
							delivery.kind === "mailbox-v2"
								? `message ${delivery.messageId} durably enqueued for subagent ${params.subagent_id}; ${delivery.pendingMessages} pending`
								: `message queued as the next turn for subagent ${params.subagent_id}`,
					},
				],
				details: {
					kind: "control",
					action: "send",
					agentId: params.subagent_id,
					...(delivery.kind === "mailbox-v2"
						? {
								messageId: delivery.messageId,
								pendingMessages: delivery.pendingMessages,
							}
						: {}),
				} satisfies ControlDetails,
			};
		},
	});

	pi.registerTool({
		name: "followup_task",
		label: "Follow-up Task",
		description:
			"For a direct mailbox-v2 continuable child, atomically claim its current pending FIFO mailbox and start exactly one scheduled turn. " +
			"This call returns turn acceptance, not the child's answer.",
		promptSnippet: "Start one mailbox-v2 child turn from queued messages",
		executionMode: "parallel",
		parameters: FollowupTaskParameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			assertBackgroundControlsEnabled(sessionSettings, "followup_task");
			const parent = await coordinator.parentFromContext(ctx);
			const outcome = await coordinator.followupTask(
				parent,
				params.subagent_id,
				signal,
			);
			return {
				content: [
					{
						type: "text",
						text: `started turn ${outcome.turnId} for subagent ${params.subagent_id}, claiming ${outcome.claimedMessages} mailbox message${outcome.claimedMessages === 1 ? "" : "s"}`,
					},
				],
				details: {
					kind: "control",
					action: "followup",
					agentId: params.subagent_id,
					turnId: outcome.turnId,
					claimedMessages: outcome.claimedMessages,
				} satisfies ControlDetails,
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
			assertBackgroundControlsEnabled(sessionSettings, "interrupt_agent");
			const parent = await coordinator.parentFromContext(ctx);
			await coordinator.interrupt(parent, params.agent_id);
			return {
				content: [{ type: "text", text: `interrupt requested for agent ${params.agent_id}` }],
				details: { kind: "control", action: "interrupt", agentId: params.agent_id } satisfies ControlDetails,
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
			assertBackgroundControlsEnabled(sessionSettings, "list_agents");
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
					sessionSettings,
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
				`Background concurrency: ${sessionSettings.maxConcurrentBackgroundRuns}`,
				`Background protocol: ${sessionSettings.backgroundProtocol ?? "legacy"}`,
				`OpenAI identity inline: ${sessionSettings.openAIIdentity ? "enabled" : "disabled"}`,
				agentSync?.diagnostics.length
					? "Bundled templates: initialization skipped (see diagnostics)"
					: `Bundled templates: initialization only (${agentSync?.packageVersion ?? "not initialized"})`,
				`User agent dir: ${agentSync?.userAgentsDir ?? coordinator.getUserAgentsDir()}`,
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
		coordinator.configureBackgroundRuns(
			loaded.settings.maxConcurrentBackgroundRuns,
		);
		sessionSettings = loaded.settings;
		agentSync = coordinator.synchronizeBundledAgents();
		sessionDiscovery = coordinator.discoverAvailableAgents(
			ctx.cwd,
			sessionSettings,
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
			disableOwnedTools(pi, registeredParameters);
		}
		if (!sessionSettings.enableRunInBackground) {
			disableOwnedTools(pi, backgroundControlParameters);
		} else if (sessionSettings.backgroundProtocol !== "mailbox-v2") {
			let hasMailboxChild = true;
			try {
				const parent = await coordinator.parentFromContext(ctx);
				const entries = await coordinator.list(parent, "descendants");
				hasMailboxChild = entries.some(
					(entry) =>
						entry.kind === "child"
						&& entry.descriptor.runtime.backgroundProtocol === "mailbox-v2",
				);
			} catch {
				// Keep the control available when catalog inspection fails so a
				// transient diagnostic cannot strand an existing mailbox child.
			}
			if (!hasMailboxChild) {
				disableOwnedTools(
					pi,
					new Map([["followup_task", FollowupTaskParameters]]),
				);
			}
		}
		if (!agentSyncNotified && agentSync) {
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
