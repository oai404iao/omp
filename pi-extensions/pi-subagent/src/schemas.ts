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
	return Type.Object(
		enableRunInBackground
			? {
					...fields,
					run_in_background: Type.Optional(
						Type.Boolean({
							description:
								"Run as a continuable background child. The spawn provider defaults this from configuration.",
						}),
					),
				}
			: fields,
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

export const ForkDelegationParameters = Type.Object(
	forkDelegationFields(),
	{ additionalProperties: false },
);

export function forkDelegationParameters(agentNames?: readonly string[]) {
	if (agentNames === undefined) return ForkDelegationParameters;
	return Type.Object(forkDelegationFields(agentNames), { additionalProperties: false });
}

export const SendMessageParameters = Type.Object(
	{
		subagent_id: Type.String({
			description: "Durable agent id of a direct continuable child",
			minLength: 1,
		}),
		message: Type.String({
			description: "Message to enqueue as the child's next FIFO turn",
			minLength: 1,
		}),
	},
	{ additionalProperties: false },
);

export const InterruptParameters = Type.Object(
	{
		agent_id: Type.String({
			description: "Agent id of a live child or deeper descendant whose current turn should stop",
			minLength: 1,
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
