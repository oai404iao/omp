import assert from "node:assert/strict";
import test from "node:test";
import { policyScripts } from "./catalog.mjs";
import { createPlan } from "./plan.mjs";
import { commandRunner, executePlan, parseRunArgs, validateConcurrency } from "./run.mjs";

const full = () => createPlan({ git: () => "a".repeat(40) });
const delay = () => new Promise(resolve => setImmediate(resolve));

test("policy precedes the bounded pool; every task is timed and ordered deterministically", async () => {
  let active = 0;
  let peak = 0;
  let policies = 0;
  const result = await executePlan(full(), { concurrency: 2, runner: async (command, { task }) => {
    if (task === "policy") policies++;
    else assert.equal(policies, policyScripts.length);
    active++;
    peak = Math.max(peak, active);
    await delay();
    active--;
    return 0;
  } });
  assert.equal(peak, 2);
  assert.equal(result.status, "passed");
  assert.equal(result.tasks.length, 13);
  assert.equal(result.tasks[0].id, "policy");
  for (const entry of result.tasks) {
    assert.equal(entry.status, "passed");
    assert.ok(entry.durationMs >= 0);
    assert.ok(entry.commands.every(command => command.durationMs >= 0));
  }
});

test("failed policy blocks expensive tasks and a pool failure still reports other tasks", async () => {
  const calls = [];
  const blocked = await executePlan(full(), { runner: async (_, { task }) => { calls.push(task); return 1; } });
  assert.deepEqual(calls, ["policy"]);
  assert.equal(blocked.status, "failed");
  assert.ok(blocked.tasks.slice(1).every(task => task.status === "skipped"));
  const failure = await executePlan(full(), { runner: async (_, { task }) => task === "consumers" ? 2 : 0 });
  assert.equal(failure.status, "failed");
  assert.equal(failure.tasks.find(task => task.id === "consumers").status, "failed");
  assert.equal(failure.tasks.find(task => task.id === "infrastructure").status, "passed");
});

test("single-task mode skips policy but rejects any task outside the selected plan", async () => {
  const calls = [];
  const result = await executePlan(full(), { task: "package:pi-local-notify", runner: async (command, { task }) => {
    calls.push(task); assert.deepEqual(command.slice(0, 3), ["pnpm", "--dir", "pi-extensions/pi-local-notify"]); return 0;
  } });
  assert.deepEqual(calls, ["package:pi-local-notify"]);
  assert.equal(result.tasks.length, 1);
  await assert.rejects(executePlan(full(), { task: "unknown" }), /not present/);
  const release = createPlan({ mode: "release", packageName: "@oai404iao/pi-telegram-notify", git: () => "a".repeat(40) });
  await assert.rejects(executePlan(release, { task: "composition" }), /not present/);
});

test("runner exceptions, missing exit status, and child signals cannot report success", async () => {
  for (const runner of [async () => { throw new Error("spawn failed"); }, async () => undefined,
    async () => ({ code: null, signal: "SIGTERM" })]) {
    const result = await executePlan(full(), { task: "composition", runner });
    assert.equal(result.status, "failed");
  }
});

test("explicit policy prerequisite mode runs the remaining bounded tasks only", async () => {
  const calls = [];
  const result = await executePlan(full(), { skipPolicy: true, runner: async (_, { task }) => {
    calls.push(task); return 0;
  } });
  assert.equal(result.status, "passed");
  assert.equal(result.policySkipped, true);
  assert.equal(result.tasks.length, 12);
  assert.ok(!calls.includes("policy"));
  assert.equal(parseRunArgs(["--skip-policy"]).skipPolicy, true);
  await assert.rejects(executePlan(full(), { skipPolicy: true, task: "policy" }), /skip-policy/);
});

test("cancellation prevents new work and preserves failure/timing report", async () => {
  const controller = new AbortController();
  const result = await executePlan(full(), { signal: controller.signal, runner: async () => {
    controller.abort(); return 0;
  } });
  assert.equal(result.status, "failed");
  assert.ok(result.tasks.every(task => task.status === "cancelled"));
});

test("real command adapter reports exit status and aborts active children", async () => {
  assert.deepEqual(await commandRunner([process.execPath, "-e", "process.exit(3)"]), { code: 3, signal: null });
  const controller = new AbortController();
  const running = commandRunner([process.execPath, "-e", "setInterval(() => {}, 1000)"], { signal: controller.signal });
  controller.abort();
  const result = await running;
  assert.notEqual(result.code, 0);
  if (process.platform !== "win32") assert.equal(result.signal, "SIGTERM");
  await assert.rejects(commandRunner([process.execPath, "-e", "process.exit(0)"], { signal: controller.signal }), /cancelled/);
});

test("invalid concurrency/CLI/plan fail before executing anything", async () => {
  for (const value of [0, 9, -1, 1.1, NaN, "abc", ""]) assert.throws(() => validateConcurrency(value), /Concurrency/);
  assert.equal(validateConcurrency("8"), 8);
  assert.equal(parseRunArgs([]).concurrency, 2);
  assert.equal(parseRunArgs(["--full", "--task", "composition", "--concurrency", "3"]).concurrency, 3);
  assert.deepEqual(parseRunArgs(["--release", "--package", "named"]).planOptions, { mode: "release", packageName: "named" });
  for (const args of [["--plan", "a", "--full"], ["--report"], ["--shadow"], ["--output", "a"], ["--concurrency", "0"]]) {
    assert.throws(() => parseRunArgs(args));
  }
  await assert.rejects(executePlan({}), /Invalid/);
});
