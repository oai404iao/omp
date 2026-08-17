import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export const DelegationParameters = Type.Object(
	{
		agent: Type.String({
			description: "Agent definition name, such as scout, planner, reviewer, or worker",
			minLength: 1,
			maxLength: 64,
		}),
		description: Type.String({
			description: "Short 3-5 word display label for the delegated task",
			minLength: 1,
			maxLength: 200,
		}),
		prompt: Type.String({
			description: "Complete task for the child agent",
			minLength: 1,
		}),
		run_in_background: Type.Optional(
			Type.Boolean({
				description:
					"Run as a continuable background child. The spawn provider defaults this from configuration.",
			}),
		),
	},
	{ additionalProperties: false },
);

export const ForkDelegationParameters = Type.Object(
	{
		agent: Type.String({
			description: "Agent definition name, such as scout, planner, reviewer, or worker",
			minLength: 1,
			maxLength: 64,
		}),
		description: Type.String({
			description: "Short 3-5 word display label for the delegated task",
			minLength: 1,
			maxLength: 200,
		}),
		prompt: Type.String({
			description:
				"Task for a child that already sees all completed parent turns; state only the new work",
			minLength: 1,
		}),
	},
	{ additionalProperties: false },
);

export const SendMessageParameters = Type.Object(
	{
		subagent_id: Type.String({ description: "Durable id of a direct continuable child", minLength: 1 }),
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
			description: "Id of a live child or deeper descendant whose current turn should stop",
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
