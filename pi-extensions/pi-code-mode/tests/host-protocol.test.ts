import test from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { negotiatedLimits, RESOURCE_LIMITS, hostDuration } from "../src/host-protocol.ts";
import { ToolBridge } from "../src/bridge.ts";
import type { CodeModeTool } from "../src/contributions.ts";

test("Host capability negotiation is bounded and explicit; duration must be representable", () => {
	const ready = (capabilities: unknown) => ({ type: "connection/ready", selectedVersion: 1, capabilities });
	assert.equal(negotiatedLimits(ready([])), false);
	assert.equal(negotiatedLimits(ready([RESOURCE_LIMITS])), true);
	for (const values of [null, "all", [RESOURCE_LIMITS, RESOURCE_LIMITS], ["unknown"], [3]]) {
		assert.throws(() => negotiatedLimits(ready(values)), /Incompatible/);
	}
	assert.throws(() => negotiatedLimits({ ...ready([]), selectedVersion: 2 }), /Incompatible/);
	assert.equal(hostDuration(undefined), 0);
	assert.equal(hostDuration(123), 123);
	for (const value of [null, -1, 0.1, Infinity, "5", Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => hostDuration(value));
});

test("empty object inputs normalize before prepare/policy, without coercing fields or required arguments", async () => {
	const seen: unknown[] = [];
	const tools: CodeModeTool[] = [{
		name: "optional", description: "test", effect: "read",
		parameters: Type.Object({ value: Type.Optional(Type.Union([Type.Null(), Type.String()])) }, { additionalProperties: false }),
		prepare: (input) => { seen.push(input); return input; },
		invoke: async (input) => ({ value: input as Record<string, never> }),
	}, {
		name: "required", description: "test", effect: "read",
		parameters: Type.Object({ value: Type.String() }),
		invoke: async () => { throw new Error("Must not execute"); },
	}];
	const signal = new AbortController().signal;
	const bridge = new ToolBridge(tools, [{ id: "test", before: (call) => {
		assert(Object.isFrozen(call.input));
		seen.push(call.input);
	} }], "test", process.cwd(), signal, () => undefined, () => {}, () => {});
	try {
		for (const [index, value] of [null, undefined, {}].entries()) assert.deepEqual(await bridge.invoke("optional", value, `${index}`, signal), {});
		assert.deepEqual(await bridge.invoke("optional", { value: null }, "field", signal), { value: null });
		assert.deepEqual(seen.slice(0, 6), [{}, {}, {}, {}, {}, {}]);
		for (const value of [null, {}, [], "x"]) await assert.rejects(bridge.invoke("required", value, "bad", signal), /Invalid nested/);
	} finally { bridge.stop(); await bridge.settled(); }
});
