import type {
	DelegationDetails,
	SubagentStopReason,
} from "./types.ts";

export type AgentLifecycleState = "open" | "closed";
export type AgentResidencyState = "resident" | "unloaded";

export type AgentTurnState =
	| { state: "none" }
	| { state: "queued"; turnId: string }
	| { state: "running"; turnId: string }
	| { state: "completed"; turnId: string }
	| { state: "errored"; turnId: string }
	| { state: "interrupted"; turnId: string };

export interface AgentControlState {
	lifecycle: AgentLifecycleState;
	residency: AgentResidencyState;
	turn: AgentTurnState;
}

export function createAgentControlState(): AgentControlState {
	return {
		lifecycle: "open",
		residency: "resident",
		turn: { state: "none" },
	};
}

export function queueAgentTurn(state: AgentControlState, turnId: string): void {
	if (state.turn.state === "queued" || state.turn.state === "running") {
		throw new Error(`agent turn ${state.turn.turnId} is already active`);
	}
	state.turn = { state: "queued", turnId };
}

export function startAgentTurn(state: AgentControlState, turnId: string): void {
	if (state.turn.state !== "queued" || state.turn.turnId !== turnId) {
		throw new Error(`agent turn ${turnId} was not queued`);
	}
	state.turn = { state: "running", turnId };
}

export function finishAgentTurn(
	state: AgentControlState,
	turnId: string,
	stopReason: SubagentStopReason,
): void {
	if (
		(state.turn.state !== "queued" &&
			state.turn.state !== "running" &&
			state.turn.state !== "interrupted") ||
		state.turn.turnId !== turnId
	) {
		throw new Error(`agent turn ${turnId} is not active`);
	}
	switch (stopReason) {
		case "completed":
			state.turn = { state: "completed", turnId };
			return;
		case "aborted":
			state.turn = { state: "interrupted", turnId };
			return;
		case "error":
		case "max-tokens":
			state.turn = { state: "errored", turnId };
			return;
	}
}

export function interruptAgentTurn(state: AgentControlState): void {
	if (state.turn.state === "queued" || state.turn.state === "running") {
		state.turn = { state: "interrupted", turnId: state.turn.turnId };
	}
}

export function setAgentResidency(
	state: AgentControlState,
	residency: AgentResidencyState,
): void {
	state.residency = residency;
}

export function closeAgent(state: AgentControlState): void {
	state.lifecycle = "closed";
}

export function currentAgentTurnId(state: AgentControlState): string | undefined {
	return state.turn.state === "none" ? undefined : state.turn.turnId;
}

export function delegationStatus(
	state: AgentControlState,
	hasOwnedChildren: boolean,
): DelegationDetails["status"] {
	switch (state.turn.state) {
		case "none":
		case "queued":
			return "starting";
		case "running":
			return "running";
		case "completed":
			return hasOwnedChildren ? "waiting" : "completed";
		case "errored":
		case "interrupted":
			return hasOwnedChildren ? "waiting" : "failed";
	}
}

export function catalogStatus(
	state: AgentControlState,
): "running" | "idle" | "ready" {
	if (state.residency === "unloaded") return "ready";
	switch (state.turn.state) {
		case "queued":
		case "running":
			return "running";
		case "none":
		case "completed":
		case "errored":
		case "interrupted":
			return "idle";
	}
}
