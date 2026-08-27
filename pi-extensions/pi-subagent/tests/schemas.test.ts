import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DelegationParameters,
	FollowupTaskParameters,
	WaitAgentParameters,
	ForkDelegationParameters,
	ForegroundForkDelegationParameters,
	ForegroundDelegationParameters,
	delegationParameters,
	forkDelegationParameters,
} from "../src/schemas.ts";

function properties(schema: unknown): Record<string, unknown> {
	return (schema as { properties: Record<string, unknown> }).properties;
}

function agentEnum(schema: unknown): unknown {
	return (properties(schema).agent as { enum?: unknown }).enum;
}

test("foreground-only delegation schema omits run_in_background", () => {
	assert.equal("run_in_background" in properties(ForegroundDelegationParameters), false);
	assert.equal(delegationParameters(false), ForegroundDelegationParameters);
});

test("background-enabled delegation schema exposes run_in_background", () => {
	assert.equal("run_in_background" in properties(DelegationParameters), true);
	assert.equal(delegationParameters(true), DelegationParameters);
});

test("delegation exposes readable task names and explicit context policy", () => {
	const fields = properties(DelegationParameters);
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

test("fork stays foreground by default but can expose continuable mode", () => {
	assert.equal(
		"run_in_background" in properties(ForkDelegationParameters),
		true,
	);
	assert.equal(
		"run_in_background" in properties(ForegroundForkDelegationParameters),
		false,
	);
	assert.equal(
		forkDelegationParameters(undefined, false),
		ForegroundForkDelegationParameters,
	);
});

test("delegation schemas constrain agent names to the discovered catalog", () => {
	const names = ["scout", "security-reviewer", "scout"];
	assert.deepEqual(agentEnum(delegationParameters(true, names)), [
		"scout",
		"security-reviewer",
	]);
	assert.deepEqual(agentEnum(delegationParameters(false, names)), [
		"scout",
		"security-reviewer",
	]);
	assert.deepEqual(agentEnum(forkDelegationParameters(names)), [
		"scout",
		"security-reviewer",
	]);
});

test("static delegation schemas remain open when no catalog is supplied", () => {
	assert.equal(agentEnum(DelegationParameters), undefined);
	assert.equal(agentEnum(ForegroundDelegationParameters), undefined);
	assert.equal(agentEnum(ForkDelegationParameters), undefined);
	assert.equal(forkDelegationParameters(), ForkDelegationParameters);
});

test("an explicitly empty catalog produces an empty enum", () => {
	assert.deepEqual(agentEnum(delegationParameters(true, [])), []);
	assert.deepEqual(agentEnum(delegationParameters(false, [])), []);
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
