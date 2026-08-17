import assert from "node:assert/strict";
import { test } from "node:test";
import {
	MUTATION_TOOL_GROUP,
	assertSupportedToolReferences,
	buildToolCeiling,
	resolveToolPolicy,
} from "../src/tool-policy.ts";

test("mutation group grants a hard ceiling for native and extension implementations", () => {
	assert.deepEqual(
		buildToolCeiling({
			requested: ["read", MUTATION_TOOL_GROUP],
			mandatory: ["report"],
		}),
		["read", "apply_patch", "edit", "write", "report"],
	);
});

test("mutation group prefers an extension-selected apply_patch", () => {
	const policy = resolveToolPolicy({
		requested: ["read", MUTATION_TOOL_GROUP],
		registered: ["read", "apply_patch", "edit", "write"],
		active: ["read", "apply_patch"],
	});
	assert.deepEqual(policy.activeTools, ["read", "apply_patch"]);
	assert.deepEqual(policy.resolvedRequestedTools, ["read", "apply_patch"]);
});

test("mutation group falls back to active native mutation tools", () => {
	const policy = resolveToolPolicy({
		requested: [MUTATION_TOOL_GROUP],
		registered: ["edit", "write"],
		active: ["edit", "write"],
	});
	assert.deepEqual(policy.activeTools, ["edit", "write"]);
});

test("explicit tools cannot reactivate an extension-disabled tool", () => {
	assert.throws(
		() =>
			resolveToolPolicy({
				requested: ["apply_patch"],
				registered: ["apply_patch", "edit", "write"],
				active: ["edit", "write"],
			}),
		/inactive for the selected model or child extension policy/,
	);
});

test("an omitted allowlist preserves extension choices while applying runtime controls", () => {
	const policy = resolveToolPolicy({
		requested: undefined,
		mandatory: ["report"],
		denied: ["internal_only"],
		registered: ["read", "apply_patch", "report", "internal_only"],
		active: ["read", "apply_patch", "internal_only"],
	});
	assert.deepEqual(policy.activeTools, ["read", "apply_patch", "report"]);
});

test("unknown logical tool groups fail loud", () => {
	assert.throws(
		() => assertSupportedToolReferences(["read", "$unknown"], "agent.md: tools"),
		/unsupported logical tool "\$unknown"/,
	);
});
