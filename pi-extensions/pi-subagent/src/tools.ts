import { defineTool, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentCaller, SubagentCoordinator } from "./coordinator.ts";
import type { AgentDefinition, SpawnInput } from "./types.ts";
import {
	AcceptedOutput, FollowupTaskParameters, InterruptOutput, InterruptParameters, ListAgentsParameters,
	ListOutput, SendMessageParameters, SpawnOutput, TOOL_DESCRIPTIONS, WaitAgentParameters, WaitOutput,
	spawnAgentDescription, spawnAgentParameters,
} from "./schemas.ts";
import { renderAgentCall, renderAgentResult } from "./render.ts";

function result<T extends Record<string, unknown>>(value: T) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value) }],
		details: value, structuredContent: value,
	};
}

/** The root and every child register these exact definitions and handlers. */
export function createAgentTools(
	controller: SubagentCoordinator | (() => SubagentCoordinator),
	caller: (ctx: ExtensionContext) => AgentCaller,
	agents: readonly AgentDefinition[],
): ToolDefinition[] {
	const getController = () => typeof controller === "function" ? controller() : controller;
	const common = { exposure: "model-only" as const, executionMode: "parallel" as const };
	return [
		defineTool({
			...common, name: "spawn_agent", label: "Spawn Agent",
			description: spawnAgentDescription(agents), parameters: spawnAgentParameters(agents), outputSchema: SpawnOutput,
			execute: async (_id, params, signal, _update, ctx) =>
				result(await getController().spawn(caller(ctx), params as SpawnInput, signal)),
			renderCall: (args, theme) => renderAgentCall("spawn_agent", args, theme),
			renderResult: (value, options, theme) => renderAgentResult(value.content, options.expanded, theme),
		}),
		defineTool({
			...common, name: "send_message", label: "Send Message",
			description: TOOL_DESCRIPTIONS.send_message, parameters: SendMessageParameters, outputSchema: AcceptedOutput,
			execute: async (_id, params, signal, _update, ctx) =>
				result(getController().send(caller(ctx), params.target, params.message, signal)),
			renderCall: (args, theme) => renderAgentCall("send_message", args, theme),
		}),
		defineTool({
			...common, name: "followup_task", label: "Follow-up Task",
			description: TOOL_DESCRIPTIONS.followup_task, parameters: FollowupTaskParameters, outputSchema: AcceptedOutput,
			execute: async (_id, params, signal, _update, ctx) =>
				result(await getController().followup(caller(ctx), params.target, params.message, signal)),
			renderCall: (args, theme) => renderAgentCall("followup_task", args, theme),
		}),
		defineTool({
			...common, name: "wait_agent", label: "Wait Agent",
			description: TOOL_DESCRIPTIONS.wait_agent, parameters: WaitAgentParameters, outputSchema: WaitOutput,
			execute: async (_id, params, signal, _update, ctx) =>
				result({ ...await getController().wait(caller(ctx), params.timeout_ms, signal, () => ctx.hasPendingMessages()) }),
		}),
		defineTool({
			...common, name: "interrupt_agent", label: "Interrupt Agent",
			description: TOOL_DESCRIPTIONS.interrupt_agent, parameters: InterruptParameters, outputSchema: InterruptOutput,
			execute: async (_id, params, _signal, _update, ctx) =>
				result(getController().interrupt(caller(ctx), params.target)),
		}),
		defineTool({
			...common, name: "list_agents", label: "List Agents",
			description: TOOL_DESCRIPTIONS.list_agents, parameters: ListAgentsParameters, outputSchema: ListOutput,
			execute: async (_id, params, _signal, _update, ctx) =>
				result({ agents: getController().list(caller(ctx), params.path_prefix).agents.map(agent => ({ ...agent })) }),
			renderResult: (value, options, theme) => renderAgentResult(value.content, options.expanded, theme),
		}),
	];
}
