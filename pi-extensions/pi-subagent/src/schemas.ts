import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

function agentNameParameter(agentNames?: readonly string[]) {
	if (agentNames === undefined) {
		return Type.String({
			description: "Agent definition name",
			minLength: 1,
			maxLength: 64,
		});
	}
	return StringEnum([...new Set(agentNames)], {
		description: "Available agent definition name",
	});
}

function delegationFields(agentNames?: readonly string[]) {
	return {
		agent: agentNameParameter(agentNames),
		task_name: Type.Optional(
			Type.String({
				description:
					"Stable readable child path segment; lowercase letters, digits, hyphens, and underscores",
				pattern: "^[a-z0-9][a-z0-9_-]{0,63}$",
				minLength: 1,
				maxLength: 64,
			}),
		),
		description: Type.String({
			description: "Short 3-5 word display label for the delegated task",
			minLength: 1,
			maxLength: 200,
		}),
		prompt: Type.String({
			description: "Complete task for the child agent",
			minLength: 1,
		}),
	};
}

const ContextParameters = Type.Object(
	{
		mode: StringEnum(
			["fresh", "all_completed", "last_n_completed"] as const,
			{
				description:
					"Parent context inherited once when the child is created",
			},
		),
		completed_turns: Type.Optional(
			Type.Integer({
				description:
					"Number of completed parent turns for last_n_completed",
				minimum: 1,
				maximum: 100,
			}),
		),
	},
	{ additionalProperties: false },
);

function forkDelegationFields(agentNames?: readonly string[]) {
	return {
		...delegationFields(agentNames),
		prompt: Type.String({
			description:
				"Task for a child that already sees all completed parent turns; state only the new work",
			minLength: 1,
		}),
	};
}

function createDelegationParameters(
	enableRunInBackground: boolean,
	agentNames?: readonly string[],
) {
	const fields = delegationFields(agentNames);
	const contextualFields = {
		...fields,
		context: Type.Optional(ContextParameters),
	};
	return Type.Object(
		enableRunInBackground
			? {
					...contextualFields,
					run_in_background: Type.Optional(
						Type.Boolean({
							description:
								"Run as a continuable background child. The spawn provider defaults this from configuration.",
						}),
					),
				}
			: contextualFields,
		{ additionalProperties: false },
	);
}

export const ForegroundDelegationParameters = createDelegationParameters(false);

export const DelegationParameters = createDelegationParameters(true);

export function delegationParameters(
	enableRunInBackground: boolean,
	agentNames?: readonly string[],
) {
	if (agentNames === undefined) {
		return enableRunInBackground ? DelegationParameters : ForegroundDelegationParameters;
	}
	return createDelegationParameters(enableRunInBackground, agentNames);
}

function createForkDelegationParameters(
	enableRunInBackground: boolean,
	agentNames?: readonly string[],
) {
	const fields = forkDelegationFields(agentNames);
	return Type.Object(
		enableRunInBackground
			? {
					...fields,
					run_in_background: Type.Optional(
						Type.Boolean({
							description:
								"Run as a continuable inherited-context background child. Fork remains foreground by default.",
						}),
					),
				}
			: fields,
		{ additionalProperties: false },
	);
}

export const ForegroundForkDelegationParameters =
	createForkDelegationParameters(false);

export const ForkDelegationParameters =
	createForkDelegationParameters(true);

export function forkDelegationParameters(
	agentNames?: readonly string[],
	enableRunInBackground = true,
) {
	if (agentNames === undefined) {
		return enableRunInBackground
			? ForkDelegationParameters
			: ForegroundForkDelegationParameters;
	}
	return createForkDelegationParameters(
		enableRunInBackground,
		agentNames,
	);
}

export const SendMessageParameters = Type.Object(
	{
		subagent_id: Type.String({
			description:
				"Readable absolute/relative task path or durable id of a direct continuable child",
			minLength: 1,
			maxLength: 4096,
		}),
		message: Type.String({
			description: "Message to enqueue as the child's next FIFO turn",
			minLength: 1,
		}),
	},
	{ additionalProperties: false },
);

export const FollowupTaskParameters = Type.Object(
	{
		subagent_id: Type.String({
			description:
				"Readable absolute/relative task path or durable id of a direct mailbox-v2 continuable child",
			minLength: 1,
			maxLength: 4096,
		}),
	},
	{ additionalProperties: false },
);

export const DEFAULT_WAIT_AGENT_TIMEOUT_MS = 30_000;
export const MAX_WAIT_AGENT_TIMEOUT_MS = 120_000;

export const WaitAgentParameters = Type.Object(
	{
		timeout_ms: Type.Optional(
			Type.Integer({
				description:
					"Maximum event-driven wait in milliseconds before returning a timeout",
				minimum: 0,
				maximum: MAX_WAIT_AGENT_TIMEOUT_MS,
				default: DEFAULT_WAIT_AGENT_TIMEOUT_MS,
			}),
		),
	},
	{ additionalProperties: false },
);

export const InterruptParameters = Type.Object(
	{
		agent_id: Type.String({
			description:
				"Readable absolute/relative task path or durable id of a live descendant whose current turn should stop",
			minLength: 1,
			maxLength: 4096,
		}),
	},
	{ additionalProperties: false },
);

export const ListAgentsParameters = Type.Object(
	{
		scope: Type.Optional(
			StringEnum(["children", "descendants"] as const, {
				description: "List direct continuable children (default) or the complete descendant tree",
				default: "children",
			}),
		),
	},
	{ additionalProperties: false },
);

export const ReportParameters = Type.Object(
	{
		output: Type.String({
			description:
				"Self-contained update for the agent that started you. Reporting does not end your turn.",
			minLength: 1,
		}),
	},
	{ additionalProperties: false },
);
