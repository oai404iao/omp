import assert from "node:assert/strict";
import { test } from "node:test";
import {
	FollowupTaskParameters,
	WaitAgentParameters,
	delegationParameters,
	forkDelegationParameters,
} from "../src/schemas.ts";

function properties(schema: unknown): Record<string, unknown> {
	return (schema as { properties: Record<string, unknown> }).properties;
}

function agentEnum(schema: unknown): unknown {
	return (properties(schema).agent as { enum?: unknown }).enum;
}

test("delegation has no per-call scheduling flag", () => {
	assert.equal("run_in_background" in properties(delegationParameters()), false);
	assert.equal("run_in_background" in properties(forkDelegationParameters()), false);
});

test("delegation exposes readable task names and explicit context policy", () => {
	const fields = properties(delegationParameters());
	assert.equal("task_name" in fields, true);
	assert.equal("context" in fields, true);
	const context = fields.context as {
		properties?: Record<string, unknown>;
	};
	assert.deepEqual(
		(context.properties?.mode as { enum?: unknown }).enum,
		["fresh", "all_completed", "last_n_completed"],
	);
	assert.equal("completed_turns" in (context.properties ?? {}), true);
});

test("fork delegates inherited context without a context parameter", () => {
	const fields = properties(forkDelegationParameters());
	assert.equal("context" in fields, false);
	assert.equal(
		(forkDelegationParameters() as { additionalProperties?: unknown }).additionalProperties,
		false,
	);
});

test("delegation schemas constrain agent names to the discovered catalog", () => {
	const names = ["scout", "security-reviewer", "scout"];
	assert.deepEqual(agentEnum(delegationParameters(names)), [
		"scout",
		"security-reviewer",
	]);
	assert.deepEqual(agentEnum(forkDelegationParameters(names)), [
		"scout",
		"security-reviewer",
	]);
});

test("static delegation schemas remain open when no catalog is supplied", () => {
	assert.equal(agentEnum(delegationParameters()), undefined);
	assert.equal(agentEnum(forkDelegationParameters()), undefined);
});

test("an explicitly empty catalog produces an empty enum", () => {
	assert.deepEqual(agentEnum(delegationParameters([])), []);
	assert.deepEqual(agentEnum(forkDelegationParameters([])), []);
});

test("followup_task accepts one readable path or durable child id", () => {
	assert.deepEqual(Object.keys(properties(FollowupTaskParameters)), [
		"subagent_id",
	]);
	assert.equal(
		(FollowupTaskParameters as { additionalProperties?: unknown }).additionalProperties,
		false,
	);
});

test("wait_agent exposes only a bounded optional timeout", () => {
	assert.deepEqual(Object.keys(properties(WaitAgentParameters)), [
		"timeout_ms",
	]);
	const timeout = properties(WaitAgentParameters).timeout_ms as {
		minimum?: unknown;
		maximum?: unknown;
		default?: unknown;
	};
	assert.equal(timeout.minimum, 0);
	assert.equal(timeout.maximum, 120_000);
	assert.equal(timeout.default, 30_000);
	assert.equal(
		(WaitAgentParameters as { additionalProperties?: unknown }).additionalProperties,
		false,
	);
});
