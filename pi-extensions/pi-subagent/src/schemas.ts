import { Type } from "typebox";
import type { AgentDefinition } from "./types.ts";
import { formatAgentToolCatalog } from "./agents.ts";

export const TOOL_NAMES = [
	"spawn_agent", "send_message", "followup_task", "wait_agent", "interrupt_agent", "list_agents",
] as const;
export const DEFAULT_WAIT_AGENT_TIMEOUT_MS = 120_000;
export const MIN_WAIT_AGENT_TIMEOUT_MS = 10_000;
export const MAX_WAIT_AGENT_TIMEOUT_MS = 3_600_000;
export const MAX_MESSAGE_CHARS = 131_072;

export const TOOL_DESCRIPTIONS = {
	spawn_agent: `Start an asynchronous agent for a well-scoped task and return its canonical task path without waiting for completion. The task name identifies a new direct child of the caller and must be unique.

Parent conversation history is inherited by default through the latest completed turn. Set fork_turns to "none" for a fresh conversation and provide all necessary context in message.

Optionally select a configured agent_type. Otherwise, use the default child policy and inherit the caller's model and reasoning level. Child tools remain subject to the effective tool policy and delegation depth limit.

The child can exchange messages with agents in the same root tree. Its final result is automatically queued to its parent without starting an idle parent turn. Use followup_task to give the same agent more work.`,
	send_message: `Queue a plaintext message for an existing agent in the current root tree, including your parent or a sibling. Running agents receive messages at safe conversation boundaries. Idle agents retain messages until their next turn.

This tool does not start a new turn, interrupt work, or wait for a reply. Use followup_task when you want an idle agent to perform more work.`,
	followup_task: `Give an existing non-root agent a plaintext follow-up task. If the agent is idle, start a new turn using its existing conversation and pending messages. If it is running, deliver the task at a safe conversation boundary without interrupting its work.

A task arriving after the current run stops accepting input is retained for a subsequent run. This tool returns after acceptance, not after task completion. It cannot start a turn on /root.`,
	wait_agent: `Wait for activity in your own mailbox, including agent messages and completion notifications. Return immediately if input is already pending. New user input steered into the active turn also ends the wait.

This tool does not wait for a selected agent, return message contents, consume messages, or start another agent. Message contents are delivered separately into your conversation at a safe boundary.

Wait only when no independent work remains and further progress depends on incoming work. Implementation, review, and test runs may take several minutes. The default timeout is ${DEFAULT_WAIT_AGENT_TIMEOUT_MS} ms; use 300000 ms for longer tasks. Avoid repeated 10-30 second polling. This is an upper bound: messages or new user input end the wait early.

Values below ${MIN_WAIT_AGENT_TIMEOUT_MS} ms are raised to ${MIN_WAIT_AGENT_TIMEOUT_MS} ms; the maximum is ${MAX_WAIT_AGENT_TIMEOUT_MS} ms. A wait timeout does not cancel agents or indicate task failure. Do not restart or interrupt agents solely because a wait timed out.`,
	interrupt_agent: `Request interruption of an agent's current run and return its previously observed status. The agent keeps its identity, conversation, and undelivered messages and remains available for follow-up tasks.

An idle agent is not started. This tool does not delete the agent, recursively interrupt descendants, or guarantee that cancellation has finished when it returns. You cannot interrupt yourself or /root.`,
	list_agents: `List agents registered in the current root tree, including agents whose idle runtimes have been unloaded. Optionally filter by a canonical or caller-relative task-path prefix.

Returns agent paths and execution statuses. This tool does not start or resume agents and does not return their conversation contents.`,
} as const;

const objectOptions = { additionalProperties: false } as const;
const target = () => Type.String({
	minLength: 1, description: "Canonical agent path, or a path relative to the caller.",
});
const message = (description: string) => Type.String({
	minLength: 1, maxLength: MAX_MESSAGE_CHARS, pattern: "\\S", description,
});

export function spawnAgentParameters(agents: readonly AgentDefinition[]) {
	const properties = {
		task_name: Type.String({
			minLength: 1, maxLength: 64, pattern: "^[a-z0-9_]+$",
			description: "Unique direct-child name. 'root' is reserved.",
		}),
		message: message("Plaintext task instructions for the new agent."),
		fork_turns: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("none")], {
			default: "all", description: "Inherit completed parent conversation history, or start fresh.",
		})),
	};
	if (agents.length === 0) return Type.Object(properties, objectOptions);
	return Type.Object({
		...properties,
		agent_type: Type.Optional(Type.Union(agents.map(agent => Type.Literal(agent.name)), {
			description: "Optional configured agent definition.",
		})),
	}, objectOptions);
}

export function spawnAgentDescription(agents: readonly AgentDefinition[]): string {
	return TOOL_DESCRIPTIONS.spawn_agent + formatAgentToolCatalog([...agents]);
}

export const SendMessageParameters = Type.Object({
	target: target(), message: message("Plaintext message to deliver."),
}, objectOptions);
export const FollowupTaskParameters = Type.Object({
	target: target(), message: message("Plaintext instructions for the follow-up task."),
}, objectOptions);
export const WaitAgentParameters = Type.Object({
	timeout_ms: Type.Optional(Type.Integer({
		minimum: 0, maximum: MAX_WAIT_AGENT_TIMEOUT_MS, default: DEFAULT_WAIT_AGENT_TIMEOUT_MS,
		description: `Maximum wait in milliseconds, not a task deadline. Defaults to ${DEFAULT_WAIT_AGENT_TIMEOUT_MS}; use 300000 for longer tasks. Activity ends the wait early. Values below ${MIN_WAIT_AGENT_TIMEOUT_MS} are raised to ${MIN_WAIT_AGENT_TIMEOUT_MS}.`,
	})),
}, objectOptions);
export const InterruptParameters = Type.Object({ target: target() }, objectOptions);
export const ListAgentsParameters = Type.Object({
	path_prefix: Type.Optional(Type.String({
		minLength: 1, description: "Optional task-path prefix without a trailing slash.",
	})),
}, objectOptions);

export const AgentStatusSchema = Type.Union(
	["pending_init", "running", "completed", "interrupted", "errored"].map(value => Type.Literal(value)),
);
export const SpawnOutput = Type.Object({ task_name: Type.String() }, objectOptions);
export const AcceptedOutput = Type.Object({ accepted: Type.Literal(true) }, objectOptions);
export const WaitOutput = Type.Object({ message: Type.String(), timed_out: Type.Boolean() }, objectOptions);
export const InterruptOutput = Type.Object({ previous_status: AgentStatusSchema }, objectOptions);
export const ListOutput = Type.Object({
	agents: Type.Array(Type.Object({ agent_name: Type.String(), agent_status: AgentStatusSchema }, objectOptions)),
}, objectOptions);
