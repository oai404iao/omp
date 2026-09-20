import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { createLabBridge } from "./bridge.mjs";

const invocation = (input = { path: "fixture.txt" }, name = "read") => ({
  tool_name: { name, namespace: null }, input,
});
const schema = Type.Object({ path: Type.String() }, { additionalProperties: false });
const result = { content: [{ type: "text", text: "fixture" }], details: { private: "do not expose" } };

test("lab bridge: authorization, schema and approval failures have zero tool effects", async () => {
  let effects = 0;
  const adapters = new Map([["read", { parameters: schema, invoke: async () => { effects++; return result; } }]]);
  for (const authorize of [undefined, () => false, () => { throw new Error("policy failed"); }, () => new Promise(() => {})]) {
    const bridge = createLabBridge({ adapters, authorize, approvalMs: 20 });
    // Keep the loop alive for the AbortSignal timeout (its internal timer is unref'd).
    const keepAlive = setTimeout(() => {}, 1000);
    try { await assert.rejects(bridge.invoke(invocation())); }
    finally { clearTimeout(keepAlive); }
    assert.equal(effects, 0);
    assert.equal(bridge.stats().active, 0);
  }
  const bridge = createLabBridge({ adapters, authorize: () => true });
  await assert.rejects(bridge.invoke(invocation({ path: 1 })), /Invalid tool arguments/);
  await assert.rejects(bridge.invoke(invocation({}, "unknown")), /No authorized adapter/);
  await assert.rejects(bridge.invoke(invocation({}, "exec")), /Invalid nested tool identity/);
  assert.equal(effects, 0);
});

test("lab bridge: final normalized args are approved and cannot mutate; details are not exported", async () => {
  let seen;
  const bridge = createLabBridge({
    authorize: ({ args }) => { seen = args; assert(Object.isFrozen(args)); return true; },
    adapters: new Map([["read", {
      parameters: schema, prepare: (args) => ({ path: args.path.trim() }),
      invoke: async (args) => { assert.equal(args, seen); assert.equal(args.path, "fixture.txt"); return result; },
    }]]),
  });
  assert.deepEqual(await bridge.invoke(invocation({ path: " fixture.txt " })), { content: result.content });
});

test("lab bridge: bounded calls, concurrency and output; abort keeps slot until effects settle", async () => {
  let finish;
  let started;
  const began = new Promise((resolve) => { started = resolve; });
  const bridge = createLabBridge({
    maxConcurrent: 1, maxCalls: 3, authorize: () => true,
    adapters: new Map([["read", { parameters: schema, invoke: () => {
      started();
      return new Promise((resolve) => { finish = () => resolve(result); });
    } }]]),
  });
  const controller = new AbortController();
  const pending = bridge.invoke(invocation(), controller.signal);
  await began;
  controller.abort(new Error("cancelled"));
  await assert.rejects(bridge.invoke(invocation()), /Concurrency budget/);
  assert.equal(bridge.stats().active, 1, "abort cannot free an in-flight effect's slot");
  finish();
  await assert.rejects(pending, /cancelled/);
  assert.equal(bridge.stats().active, 0);
  await assert.rejects(bridge.invoke(invocation({}, "unknown")));
  await assert.rejects(bridge.invoke(invocation()), /Call budget/);
  const oversized = createLabBridge({
    authorize: () => true, maxResultBytes: 10,
    adapters: new Map([["read", { parameters: schema, invoke: async () => result }]]),
  });
  await assert.rejects(oversized.invoke(invocation()), /Result budget/);
});

test("lab bridge: cancellation during approval never invokes the tool even after late approval", async () => {
  let effects = 0;
  const controller = new AbortController();
  const bridge = createLabBridge({
    authorize: async () => { await delay(30); return true; },
    adapters: new Map([["read", { parameters: schema, invoke: async () => { effects++; return result; } }]]),
  });
  const pending = bridge.invoke(invocation(), controller.signal);
  controller.abort(new Error("cancelled approval"));
  await assert.rejects(pending, /cancelled approval/);
  await delay(40);
  assert.equal(effects, 0);
});
