import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DelegationParameters,
	ForegroundDelegationParameters,
	delegationParameters,
} from "../src/schemas.ts";

function properties(schema: unknown): Record<string, unknown> {
	return (schema as { properties: Record<string, unknown> }).properties;
}

test("foreground-only delegation schema omits run_in_background", () => {
	assert.equal("run_in_background" in properties(ForegroundDelegationParameters), false);
	assert.equal(delegationParameters(false), ForegroundDelegationParameters);
});

test("background-enabled delegation schema exposes run_in_background", () => {
	assert.equal("run_in_background" in properties(DelegationParameters), true);
	assert.equal(delegationParameters(true), DelegationParameters);
});
