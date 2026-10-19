import assert from "node:assert/strict";
import { test } from "node:test";
import {
	MUTATION_TOOL_GROUP,
	buildToolCeiling,
	buildToolExclusions,
	resolveToolPolicy,
} from "../src/tool-policy.ts";

test("mutation group grants a hard ceiling for native and extension implementations", () => {
	assert.deepEqual(
		buildToolCeiling({
			requested: ["read", MUTATION_TOOL_GROUP],
			mandatory: ["send_message"],
		}),
		["read", "apply_patch", "edit", "write", "send_message"],
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
		mandatory: ["send_message"],
		denied: ["internal_only"],
		registered: ["read", "apply_patch", "send_message", "internal_only"],
		active: ["read", "apply_patch", "internal_only"],
	});
	assert.deepEqual(policy.activeTools, ["read", "apply_patch", "send_message"]);
});

test("the permission ceiling does not eagerly declare deferred tools activated during SDK setup", () => {
	const policy = resolveToolPolicy({
		requested: ["codemode", "deferred_tool"],
		registered: ["codemode", "deferred_tool"],
		active: ["codemode", "deferred_tool"],
		callable: ["deferred_tool"],
		callableOnly: ["deferred_tool"],
	});
	assert.deepEqual(policy.activeTools, ["codemode"]);
});

test("callability cannot bypass registration or denial", () => {
	const options = { requested: ["restricted"], active: [], callable: ["restricted"] };
	assert.throws(() => resolveToolPolicy({ ...options, registered: [] }), /not registered/);
	assert.throws(() => resolveToolPolicy({ ...options, registered: ["restricted"], denied: ["restricted"] }), /unavailable/);
});

test("exact ceilings exclude implicit MCP tools and independently grant resource tools", () => {
	assert.deepEqual(buildToolExclusions(undefined), []);
	assert.deepEqual(buildToolExclusions(["read", "send_message"]), [
		"mcp__*", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource",
	]);
	assert.deepEqual(buildToolExclusions(["mcp__docs__lookup", "read_mcp_resource"]), [
		"list_mcp_resources", "list_mcp_resource_templates",
	]);
});

test("CLI modifiers and patterns cannot weaken an exact role ceiling", () => {
	for (const selector of ["read*", "mcp__docs__*", "+codemode", "-write"]) {
		assert.throws(() => buildToolCeiling({ requested: [selector] }), /unsupported selector.*exact tool names/);
		assert.throws(() => resolveToolPolicy({ requested: [selector], registered: [], active: [] }), /unsupported selector/);
	}
});
