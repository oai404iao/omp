import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { execFileSync } from "node:child_process";
import { Host, resultBody, texts, tool } from "./host-client.mjs";
import { createLabBridge } from "./bridge.mjs";

const run = (name, callback) => test(name, { timeout: 18000 }, async (t) => {
  const host = await Host.open();
  t.after(() => host.close());
  await callback(host);
});
const completed = async (host, response) => {
  let current = response;
  for (let attempts = 0; resultBody(current).kind === "Yielded" && attempts < 20; attempts++) {
    current = await host.wait(resultBody(current).cell_id, 100);
  }
  assert.equal(resultBody(current).kind, "Result");
  return current;
};

run("host: actual V1 handshake, arithmetic, fresh isolate and JSON store", async (host) => {
  assert.deepEqual(texts(await host.execute("globalThis.onlyHere=7; store('k',{n:42}); text(6*7)")), ["42"]);
  assert.deepEqual(texts(await host.execute("text(typeof onlyHere); text(load('k'))")), ["undefined", '{"n":42}']);
  const failed = await host.execute("store('beforeError', 9); throw new Error('expected failure')");
  assert.match(resultBody(failed).error_text, /expected failure/);
  assert.deepEqual(texts(await host.execute("text(load('beforeError'))")), ["9"], "failed Result still commits store writes");
  const previous = host.sessionId;
  host.sessionId = "second-session";
  await host.request({ method: "session/open", sessionId: host.sessionId });
  assert.deepEqual(texts(await host.execute("text(typeof load('k'))")), ["undefined"]);
  await host.request({ method: "session/shutdown", sessionId: host.sessionId });
  host.sessionId = previous;
});

run("host: no ambient I/O globals or module imports; images are typed output", async (host) => {
  const response = await host.execute("text([typeof process, typeof require, typeof fetch, typeof Deno, typeof console])");
  assert.deepEqual(JSON.parse(texts(response)[0]), Array(5).fill("undefined"));
  for (const source of ["import x from 'node:fs';", "await import('node:fs')"]) {
    assert.match(resultBody(await host.execute(source)).error_text, /unsupported import/i);
  }
  const image = await host.execute("image('data:image/png;base64,aGVsbG8=')");
  assert.equal(resultBody(image).content_items[0].type, "input_image");
  assert.equal(resultBody(image).content_items[0].image_url, "data:image/png;base64,aGVsbG8=");
  // A shape test only: this is intentionally not a valid PNG decoder/provider test.
});

run("host: actual delegate bridge, parallel JS calls and catchable denials", async (host) => {
  const bridge = createLabBridge({
    authorize: ({ args }) => args.n !== 99,
    adapters: new Map([["echo", {
      parameters: Type.Object({ n: Type.Integer() }),
      invoke: async ({ n }) => { await delay(20); return { content: [{ type: "text", text: String(n) }] }; },
    }]]),
  });
  host.invoke = (invocation, signal) => bridge.invoke(invocation, signal);
  const response = await completed(host, await host.execute(
    "const rs=await Promise.all([tools.echo({n:1}),tools.echo({n:2})]); text(rs); try {await tools.echo({n:99})} catch(e) {text(String(e))}",
    { tools: [tool("echo")], yieldMs: 500 },
  ));
  assert.equal(JSON.parse(texts(response)[0]).length, 2);
  assert.match(texts(response)[1], /approval denied/);
  assert.equal(bridge.stats().peak, 2);
  assert.equal(bridge.stats().active, 0);
});

run("host: pending cell, wait, cancellation of delegated work and discarded store", async (host) => {
  let delegated;
  const requested = new Promise((resolve) => { delegated = resolve; });
  let cancelled;
  const aborted = new Promise((resolve) => { cancelled = resolve; });
  host.invoke = (_call, signal) => new Promise((_, reject) => {
    delegated();
    signal.addEventListener("abort", () => { cancelled(); reject(new Error("nested aborted")); }, { once: true });
  });
  const initial = await host.execute("store('discard',1); await tools.block({}); text('never')", { tools: [tool("block")] });
  assert.equal(resultBody(initial).kind, "Yielded");
  await requested;
  const cell = resultBody(initial).cell_id;
  assert.equal(resultBody(await host.wait(cell, 10)).kind, "Yielded");
  assert.equal(resultBody(await host.terminate(cell)).kind, "Terminated");
  await aborted;
  assert.deepEqual(texts(await host.execute("text(typeof load('discard'))")), ["undefined"]);
  assert.match(resultBody(await host.wait(cell)).error_text, /not found/);
});

run("host: CPU infinite loop remains terminable; yield is NOT an execution deadline", async (host) => {
  const first = await host.execute("while(true){}", { yieldMs: 10 });
  assert.equal(resultBody(first).kind, "Yielded");
  const cell = resultBody(first).cell_id;
  assert.equal(resultBody(await host.wait(cell, 10)).kind, "Yielded");
  assert.equal(resultBody(await host.terminate(cell)).kind, "Terminated");
  assert.deepEqual(texts(await host.execute("text('recovered')")), ["recovered"]);
});

run("host: operation/cancel does not replace explicit cell termination", async (host) => {
  const operation = host.start("await new Promise(()=>{})", { yieldMs: 2000 });
  const { cellId } = await operation.started;
  const observer = `execute/initialResponse:${operation.id}`;
  assert(host.pending.has(observer), "initial response must still be pending BEFORE cancel");
  host.send({ type: "operation/cancel", id: operation.id });
  // Input FIFO + an unrelated roundtrip prove the Host received cancel while
  // the initial observer was pending, rather than cancelling an already-done op.
  await host.request({ method: "session/open", sessionId: "cancel-barrier" });
  assert(host.pending.has(observer), "initial observer remains pending AFTER cancel roundtrip");
  assert.equal(resultBody(await operation.initial).kind, "Yielded", "cancel after execution/started does not cancel initial observation");
  const wait = host.wait(cellId, 5000);
  host.send({ type: "operation/cancel", id: host.sequence });
  await assert.rejects(wait, /cancelled/);
  assert.equal(resultBody(await host.wait(cellId, 10)).kind, "Yielded");
  assert.equal(resultBody(await host.terminate(cellId)).kind, "Terminated");
});

run("host: max_output_tokens is NOT enforced by pinned Host", async (host) => {
  const response = await host.execute("text('x'.repeat(20000))", { maxTokens: 5 });
  assert.equal(texts(response)[0].length, 20000);
});

run("host: lab frame budget rejects bounded oversized output", async (host) => {
  host.frameLimit = 32768;
  await assert.rejects(host.execute("text('x'.repeat(65536))"), /frame budget exceeded/);
  assert(host.failure, "oversized frame invalidates the lab client");
});

run("host: bounded 32-call fanout meets explicit bridge quota, not a Host policy", async (host) => {
  let effects = 0;
  const bridge = createLabBridge({
    maxCalls: 8, maxConcurrent: 2, authorize: () => true,
    adapters: new Map([["echo", { parameters: Type.Object({}), invoke: async () => {
      effects++; await delay(20); return { content: [] };
    } }]]),
  });
  host.invoke = (call, signal) => bridge.invoke(call, signal);
  const response = await completed(host, await host.execute(
    "text(await Promise.allSettled(Array.from({length:32},()=>tools.echo({}))))",
    { tools: [tool("echo")], yieldMs: 500 },
  ));
  const values = JSON.parse(texts(response)[0]);
  assert.equal(values.length, 32);
  assert(values.some((item) => item.status === "rejected" && String(item.reason).includes("budget")));
  assert(effects <= 2);
  assert.equal(bridge.stats().peak, 2);
});

run("host: unknown heap-limit field rejects protocol; it cannot enable a memory budget", async (host) => {
  await assert.rejects(host.execute("text(1)", { extra: { max_heap_size_bytes: 1048576 } }));
  await host.exited;
  assert.match(host.stderr, /unknown field.*max_heap_size_bytes/);
  assert.notEqual(host.exit.code, 0);
});

run("host: OS cgroup enforces memory budget on bounded allocation; pending calls fail", async (host) => {
  // <= 1 GiB requested in a verified 192 MiB, no-swap cgroup, never unbounded RAM.
  const operation = host.start("const held=[]; for(let i=0;i<32;i++) held.push(new Array(4000000).fill(i)); text('unexpected')");
  await operation.started;
  // Initial observation may yield before OOM; pending observation must still fail on death.
  const initial = await operation.initial.catch(() => null);
  if (initial) {
    assert.equal(resultBody(initial).kind, "Yielded");
    await assert.rejects(host.wait(resultBody(initial).cell_id, 5000));
  }
  await host.exited;
  const outcome = host.property("Result");
  appendFileSync(join(process.env.CODE_MODE_S0_DIR, "memory.jsonl"), JSON.stringify({
    unit: host.unit, result: outcome, memoryPeak: host.property("MemoryPeak"),
    exit: host.exit, limit: host.property("MemoryMax"),
  }) + "\n");
  assert.equal(outcome, "oom-kill", "only the cgroup's OOM verdict proves this experiment");
  assert.notEqual(host.exit.code, 0);
});

test("host: incompatible version rejected before execution", { timeout: 10000 }, async (t) => {
  const host = new Host();
  t.after(() => host.close());
  const rejected = host.expect("connection/rejected", 0);
  host.send({ type: "connection/hello", supportedVersions: [999], requiredCapabilities: [], optionalCapabilities: [] });
  assert.equal((await rejected).reason.type, "noCompatibleVersion");
  await host.exited;
});

test("host: independent OS watchdog ends a CPU loop even without terminate", { timeout: 10000 }, async (t) => {
  const host = await Host.open({ runtimeSeconds: 2 });
  t.after(() => host.close());
  const initial = await host.execute("while(true){}", { yieldMs: 10 });
  assert.equal(resultBody(initial).kind, "Yielded");
  await assert.rejects(host.wait(resultBody(initial).cell_id, 5000));
  await host.exited;
  assert.equal(host.property("Result"), "timeout");
  appendFileSync(join(process.env.CODE_MODE_S0_DIR, "watchdog.jsonl"), JSON.stringify({
    result: host.property("Result"), runtimeMaxUSec: host.property("RuntimeMaxUSec"), exit: host.exit,
  }) + "\n");
});

test("host: killed Host fails pending requests; a new Host has no stale store", { timeout: 15000 }, async (t) => {
  const host = await Host.open();
  t.after(() => host.close());
  await host.execute("store('old-session',1)");
  const initial = await host.execute("await new Promise(()=>{})", { yieldMs: 10 });
  const pending = host.wait(resultBody(initial).cell_id, 5000);
  execFileSync("systemctl", ["--user", "kill", "--signal=SIGKILL", "--kill-whom=all", host.unit], { timeout: 3000 });
  await assert.rejects(pending, /Host exited/);
  await host.exited;
  const replacement = await Host.open();
  t.after(() => replacement.close());
  assert.deepEqual(texts(await replacement.execute("text(typeof load('old-session'))")), ["undefined"]);
});

test("host lab client: failure prevents late delegate requests from starting effects", async () => {
  let effects = 0;
  // No process or stress code required to test the failure-state dispatch guard.
  const host = Object.assign(Object.create(Host.prototype), {
    pending: new Map(), delegates: new Map(), notifications: [],
    invoke: async () => { effects++; return {}; },
  });
  host.fail(new Error("already closed"));
  host.receive({
    type: "delegate/request", id: 1,
    request: { type: "tool/invoke", invocation: { tool_name: { name: "late" }, input: {} } },
  });
  await delay(0);
  assert.equal(effects, 0);
  assert.equal(host.delegates.size, 0);
});
