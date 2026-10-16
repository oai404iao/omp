import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { root as repositoryRoot } from "../workspaces.mjs";
import { createPlan, parsePlanArgs, tasksForPlan, validatePlan } from "./plan.mjs";

export function validateConcurrency(value) {
  const concurrency = Number(value);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error("Concurrency must be an integer between 1 and 8");
  }
  return concurrency;
}

export function commandRunner(command, { root = repositoryRoot, signal } = {}) {
  return new Promise((resolveResult, reject) => {
    if (signal?.aborted) { reject(new Error("Execution cancelled")); return; }
    // pnpm launches descendants: stop the whole task, not just its wrapper.
    const grouped = process.platform !== "win32";
    const child = spawn(command[0], command.slice(1), { cwd: root, stdio: "inherit", detached: grouped });
    const abort = () => {
      if (!child.pid) return;
      try {
        if (grouped) process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") reject(error);
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", error => { signal?.removeEventListener("abort", abort); reject(error); });
    child.once("close", (code, childSignal) => {
      signal?.removeEventListener("abort", abort);
      resolveResult({ code, signal: childSignal });
    });
  });
}

/** Policy is a barrier; failures in a pool task do not hide other task results. */
export async function executePlan(value, { concurrency = 2, task, skipPolicy = false, runner = commandRunner,
  root = repositoryRoot, signal, now = () => performance.now() } = {}) {
  validatePlan(value);
  concurrency = validateConcurrency(concurrency);
  const available = tasksForPlan(value);
  if (task && !available.some(entry => entry.id === task)) throw new Error(`Task not present in plan: ${task}`);
  if (typeof skipPolicy !== "boolean" || (skipPolicy && task === "policy")) throw new Error("Invalid skip-policy selection");
  const selected = task ? available.filter(entry => entry.id === task)
    : available.filter(entry => !skipPolicy || entry.id !== "policy");
  const started = now();
  const results = new Map();
  async function run(entry) {
    const start = now();
    const result = { id: entry.id, status: "passed", durationMs: 0, commands: [] };
    for (const command of entry.commands) {
      if (signal?.aborted) { result.status = "cancelled"; break; }
      const commandStart = now();
      try {
        const outcome = await runner(command, { root, signal, task: entry.id });
        const code = typeof outcome === "number" ? outcome : outcome?.code;
        const childSignal = typeof outcome === "object" ? outcome?.signal : undefined;
        if (!Number.isInteger(code) && !childSignal) throw new Error("Runner returned no exit status");
        result.commands.push({ command, code, signal: childSignal || null,
          durationMs: Math.max(0, now() - commandStart) });
        if (code !== 0 || childSignal) { result.status = signal?.aborted ? "cancelled" : "failed"; break; }
      } catch (error) {
        result.status = signal?.aborted ? "cancelled" : "failed";
        result.error = error.message;
        break;
      }
    }
    result.durationMs = Math.max(0, now() - start);
    results.set(entry.id, result);
    return result;
  }
  const policy = selected.find(entry => entry.id === "policy");
  if (policy) await run(policy);
  const pending = selected.filter(entry => entry.id !== "policy");
  if (!policy || results.get("policy").status === "passed") {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
      while (next < pending.length && !signal?.aborted) await run(pending[next++]);
    }));
  }
  for (const entry of selected) if (!results.has(entry.id)) {
    results.set(entry.id, { id: entry.id, status: signal?.aborted ? "cancelled" : "skipped", durationMs: 0, commands: [] });
  }
  const tasks = selected.map(entry => results.get(entry.id));
  return { schemaVersion: 1, sourceSha: value.sourceSha, mode: value.mode, concurrency,
    durationMs: Math.max(0, now() - started), policySkipped: skipPolicy,
    status: tasks.every(entry => entry.status === "passed") && !signal?.aborted ? "passed" : "failed", tasks };
}

export function parseRunArgs(args) {
  const options = {};
  const planArgs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--skip-policy") {
      if (options.skipPolicy) throw new Error("Duplicate --skip-policy");
      options.skipPolicy = true;
      continue;
    }
    const key = { "--plan": "planPath", "--task": "task", "--concurrency": "concurrency", "--report": "report" }[args[i]];
    if (!key) { planArgs.push(args[i]); continue; }
    if (key in options || args[i + 1] === undefined || args[i + 1].startsWith("--")) throw new Error(`Invalid argument: ${args[i]}`);
    options[key] = args[++i];
  }
  const planOptions = parsePlanArgs(planArgs);
  if (planOptions.output || planOptions.githubOutput || planOptions.shadow) throw new Error("Unsupported executor option");
  if (options.planPath && Object.keys(planOptions).length) throw new Error("--plan cannot be combined with revision/package selection");
  return { ...options, planOptions, concurrency: validateConcurrency(options.concurrency ?? 2) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  let receivedSignal;
  const handlers = new Map(["SIGINT", "SIGTERM"].map(signal => [signal, () => {
    receivedSignal = signal;
    controller.abort();
  }]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  try {
    const options = parseRunArgs(process.argv.slice(2));
    const value = options.planPath ? validatePlan(JSON.parse(readFileSync(options.planPath, "utf8"))) : createPlan(options.planOptions);
    const report = await executePlan(value, { ...options, signal: controller.signal });
    if (options.report) writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`);
    for (const task of report.tasks) console.log(`[ci] ${task.id}: ${task.status} (${Math.round(task.durationMs)}ms)`);
    if (report.status !== "passed") process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    if (receivedSignal) process.kill(process.pid, receivedSignal);
  }
}
