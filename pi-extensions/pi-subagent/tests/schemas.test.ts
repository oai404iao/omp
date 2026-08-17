import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DelegationParameters,
	ForkDelegationParameters,
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
