import { defineTool, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentCaller, SubagentCoordinator } from "./coordinator.ts";
import type { AgentDefinition, AgentListItem, SpawnInput } from "./types.ts";
import {
	AcceptedOutput, CloseOutput, CloseParameters, FollowupOutput, FollowupTaskParameters, InterruptOutput, InterruptParameters, ListAgentsParameters,
	ListOutput, SendMessageParameters, SpawnOutput, TOOL_DESCRIPTIONS, WaitAgentParameters, WaitOutput,
	spawnAgentDescription, spawnAgentParameters,
} from "./schemas.ts";
import { renderAgentCall, renderAgentResult, type AgentRenderDetails } from "./render.ts";
import { resolveTaskPath, ROOT_TASK_PATH } from "./task-path.ts";

function result<T extends Record<string, unknown>>(value: T, render: AgentRenderDetails) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value) }],
		details: { ...value, render }, structuredContent: value,
	};
}

function renderArgs(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

/** The root and every child register these exact definitions and handlers. */
export function createAgentTools(
	controller: SubagentCoordinator | (() => SubagentCoordinator),
	caller: (ctx: ExtensionContext) => AgentCaller,
	agents: readonly AgentDefinition[],
	callerPath = ROOT_TASK_PATH,
): ToolDefinition[] {
	const getController = () => typeof controller === "function" ? controller() : controller;
	// Identity only: rendering must not attach sessions, load transcripts or start runtimes.
	const agentType = (reference: unknown): string => {
		if (typeof reference !== "string") return "unknown";
		try {
			const path = resolveTaskPath(callerPath, reference);
			return path === ROOT_TASK_PATH ? "root" :
				getController().treeStore.snapshot.agents[path]?.descriptor.agent.name ?? "unknown";
		} catch { return "unknown"; }
	};
	const callType = (name: string, args: Record<string, unknown>): string | undefined =>
		name === "spawn_agent" ? (typeof args.agent_type === "string" ? args.agent_type : "default") :
			name === "list_agents" ? undefined : agentType(name === "wait_agent" ? callerPath : args.target);
	const rendering = (name: string): Pick<ToolDefinition, "renderCall" | "renderResult"> => ({
		renderCall: (args, theme, context) => ({
			// Pi builds the call before the result. Defer its text until both have populated shared state.
			render: width => renderAgentCall(name, renderArgs(args), theme,
				context.state.agentType ?? callType(name, renderArgs(args))).render(width),
			invalidate: () => {},
		}),
		renderResult: (value, options, theme, context) => {
			const details = value.details as { render?: AgentRenderDetails; agents?: AgentListItem[] } | undefined;
			context.state.agentType = details?.render?.agentType;
			return renderAgentResult(value.content, options.expanded, theme, details?.render ?? {
				agentType: callType(name, renderArgs(context.args)),
				agentTypes: Array.isArray(details?.agents) ? Object.fromEntries(
					details.agents.map(agent => [agent.agent_name, agentType(agent.agent_name)]),
				) : undefined,
			}, name === "wait_agent");
		},
	});
	const common = { exposure: "model-only" as const, executionMode: "parallel" as const };
	return [
		defineTool({
			...common, ...rendering("spawn_agent"), name: "spawn_agent", label: "Spawn Agent",
			description: spawnAgentDescription(agents), parameters: spawnAgentParameters(agents), outputSchema: SpawnOutput,
			execute: async (_id, params, signal, _update, ctx) =>
				result(await getController().spawn(caller(ctx), params as SpawnInput, signal),
					{ agentType: callType("spawn_agent", params) }),
		}),
		defineTool({
			...common, ...rendering("send_message"), name: "send_message", label: "Send Message",
			description: TOOL_DESCRIPTIONS.send_message, parameters: SendMessageParameters, outputSchema: AcceptedOutput,
			execute: async (_id, params, signal, _update, ctx) =>
				result(getController().send(caller(ctx), params.target, params.message, signal),
					{ agentType: agentType(params.target) }),
		}),
		defineTool({
			...common, ...rendering("followup_task"), name: "followup_task", label: "Follow-up Task",
			description: TOOL_DESCRIPTIONS.followup_task, parameters: FollowupTaskParameters, outputSchema: FollowupOutput,
			execute: async (_id, params, signal, _update, ctx) =>
				result(await getController().followup(caller(ctx), params.target, params.message, signal,
					params as Pick<SpawnInput, "model" | "thinking">),
					{ agentType: agentType(params.target) }),
		}),
		defineTool({
			...common, ...rendering("close_agent"), name: "close_agent", label: "Close Agent",
			description: TOOL_DESCRIPTIONS.close_agent, parameters: CloseParameters, outputSchema: CloseOutput,
			execute: async (_id, params, _signal, _update, ctx) =>
				result(getController().close(caller(ctx), params.target), { agentType: agentType(params.target) }),
		}),
		defineTool({
			...common, ...rendering("wait_agent"), name: "wait_agent", label: "Wait Agent",
			description: TOOL_DESCRIPTIONS.wait_agent, parameters: WaitAgentParameters, outputSchema: WaitOutput,
			execute: async (_id, params, signal, _update, ctx) =>
				result({ ...await getController().wait(caller(ctx), params.timeout_ms, signal, () => ctx.hasPendingMessages()) },
					{ agentType: agentType(callerPath) }),
		}),
		defineTool({
			...common, ...rendering("interrupt_agent"), name: "interrupt_agent", label: "Interrupt Agent",
			description: TOOL_DESCRIPTIONS.interrupt_agent, parameters: InterruptParameters, outputSchema: InterruptOutput,
			execute: async (_id, params, _signal, _update, ctx) =>
				result(getController().interrupt(caller(ctx), params.target), { agentType: agentType(params.target) }),
		}),
		defineTool({
			...common, ...rendering("list_agents"), name: "list_agents", label: "List Agents",
			description: TOOL_DESCRIPTIONS.list_agents, parameters: ListAgentsParameters, outputSchema: ListOutput,
			execute: async (_id, params, _signal, _update, ctx) => {
				const page = getController().list(caller(ctx), params.path_prefix, params);
				const value = { ...page, agents: page.agents.map(agent => ({ ...agent })) };
				return result(value, {
					agentTypes: Object.fromEntries(value.agents.map(agent => [agent.agent_name, agentType(agent.agent_name)])),
				});
			},
		}),
	];
}
