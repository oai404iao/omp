import assert from "node:assert/strict";
import { test } from "node:test";
import {
	catalogStatus,
	closeAgent,
	createAgentControlState,
	currentAgentTurnId,
	delegationStatus,
	finishAgentTurn,
	interruptAgentTurn,
	queueAgentTurn,
	setAgentResidency,
	startAgentTurn,
} from "../src/agent-state.ts";

test("agent control state separates turn, residency, and lifecycle", () => {
	const state = createAgentControlState();
	assert.deepEqual(state, {
		lifecycle: "open",
		residency: "resident",
		turn: { state: "none" },
	});
	assert.equal(delegationStatus(state, false), "starting");
	assert.equal(catalogStatus(state), "idle");

	queueAgentTurn(state, "turn-1");
	assert.equal(currentAgentTurnId(state), "turn-1");
	assert.equal(delegationStatus(state, false), "starting");
	assert.equal(catalogStatus(state), "running");

	startAgentTurn(state, "turn-1");
	assert.equal(delegationStatus(state, false), "running");
	finishAgentTurn(state, "turn-1", "completed");
	assert.equal(delegationStatus(state, true), "waiting");
	assert.equal(delegationStatus(state, false), "completed");

	setAgentResidency(state, "unloaded");
	assert.equal(catalogStatus(state), "ready");
	closeAgent(state);
	assert.equal(state.lifecycle, "closed");
});

test("interrupted and failed turns retain their stable turn ids", () => {
	const interrupted = createAgentControlState();
	queueAgentTurn(interrupted, "turn-abort");
	startAgentTurn(interrupted, "turn-abort");
	interruptAgentTurn(interrupted);
	finishAgentTurn(interrupted, "turn-abort", "aborted");
	assert.deepEqual(interrupted.turn, {
		state: "interrupted",
		turnId: "turn-abort",
	});
	assert.equal(delegationStatus(interrupted, false), "failed");

	const errored = createAgentControlState();
	queueAgentTurn(errored, "turn-error");
	finishAgentTurn(errored, "turn-error", "error");
	assert.deepEqual(errored.turn, {
		state: "errored",
		turnId: "turn-error",
	});
});
