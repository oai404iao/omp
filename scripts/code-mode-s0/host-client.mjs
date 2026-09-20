// Deliberately small protocol-V1 LAB client, not a production extension/runtime.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const resultBody = (response) => {
  const [kind, body] = Object.entries(response)[0];
  return { kind, ...body };
};
export const texts = (response) => resultBody(response).content_items
  .filter((item) => item.type === "input_text").map((item) => item.text);
export const tool = (name) => ({
  name, tool_name: { name, namespace: null }, description: `S0 ${name}`,
  kind: "function", input_schema: { type: "object" }, output_schema: null,
});

export class Host {
  pending = new Map();
  delegates = new Map();
  notifications = [];
  buffer = Buffer.alloc(0);
  sequence = 0;
  stderr = "";
  frameLimit = 1024 * 1024;
  sessionId = randomUUID();

  static async open(options = {}) {
    const host = new Host(options);
    try {
      const ready = host.expect("connection/ready", 0);
      host.send({ type: "connection/hello", supportedVersions: [1], requiredCapabilities: [], optionalCapabilities: [] });
      assert.deepEqual(await ready, { type: "connection/ready", selectedVersion: 1, capabilities: [] });
      // Prove OS limits are effective BEFORE running any stress source.
      assert.equal(host.property("MemoryMax"), "201326592");
      assert.equal(host.property("MemorySwapMax"), "0");
      assert.equal(host.property("TasksMax"), "64");
      assert.equal(host.property("RuntimeMaxUSec"), `${host.runtimeSeconds}s`);
      // systemctl exposes requested settings. Check the actual kernel files and
      // process membership as well: an undelegated controller must fail closed.
      const controlGroup = host.property("ControlGroup");
      assert(controlGroup.startsWith("/") && !controlGroup.split("/").includes(".."));
      const kernel = Object.fromEntries(["memory.max", "memory.swap.max", "pids.max", "cpu.max"]
        .map((name) => [name, readFileSync(`/sys/fs/cgroup${controlGroup}/${name}`, "utf8").trim()]));
      assert.equal(kernel["memory.max"], "201326592");
      assert.equal(kernel["memory.swap.max"], "0");
      assert.equal(kernel["pids.max"], "64");
      const [quota, period] = kernel["cpu.max"].split(/\s+/).map(Number);
      assert(Number.isFinite(quota) && quota > 0 && quota === period, "Kernel CPU limit must be 100%");
      const pid = host.property("MainPID");
      assert(/^[1-9]\d*$/.test(pid));
      assert.equal(readFileSync(`/proc/${pid}/cgroup`, "utf8").trim(), `0::${controlGroup}`);
      appendFileSync(join(process.env.CODE_MODE_S0_DIR, "limits.jsonl"), JSON.stringify({
        unit: host.unit, memoryMax: host.property("MemoryMax"),
        memorySwapMax: host.property("MemorySwapMax"), tasksMax: host.property("TasksMax"),
        runtimeMaxUSec: host.property("RuntimeMaxUSec"), controlGroup, pid, kernel,
      }) + "\n");
      await host.request({ method: "session/open", sessionId: host.sessionId });
      return host;
    } catch (error) {
      await host.close();
      throw error;
    }
  }

  constructor({ invoke = async () => { throw new Error("No authorized adapter"); }, runtimeSeconds = 20 } = {}) {
    assert(process.env.CODE_MODE_S0_DIR && process.env.CODE_MODE_S0_HOST, "Use run.mjs; direct unsupervised stress tests are forbidden");
    assert([2, 20].includes(runtimeSeconds), "Only bounded lab watchdog settings are allowed");
    this.invoke = invoke;
    this.runtimeSeconds = runtimeSeconds;
    this.unit = `omp-code-mode-s0-${randomUUID()}.service`;
    // The outer runner can stop only this run's units if its subprocess hangs.
    appendFileSync(join(process.env.CODE_MODE_S0_DIR, "units.jsonl"), JSON.stringify({ unit: this.unit }) + "\n");
    this.child = spawn("systemd-run", [
      "--user", "--quiet", "--pipe", "--wait", `--unit=${this.unit}`, "--service-type=exec",
      "--property=MemoryMax=192M", "--property=MemorySwapMax=0", "--property=TasksMax=64",
      `--property=RuntimeMaxSec=${runtimeSeconds}s`, "--property=CPUQuota=100%", "--property=LimitCORE=0",
      "--property=UMask=0077",
      "/usr/bin/env", "-i", `HOME=${process.env.HOME}`, `TMPDIR=${process.env.CODE_MODE_S0_DIR}`,
      process.env.CODE_MODE_S0_HOST,
    ], { stdio: ["pipe", "pipe", "pipe"] });
    this.exited = new Promise((resolve) => this.child.on("close", (code, signal) => {
      this.exit = { code, signal };
      this.fail(new Error(`Host exited: ${JSON.stringify(this.exit)} ${this.stderr.slice(-1000)}`));
      resolve(this.exit);
    }));
    this.child.on("error", (error) => this.fail(error));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.stderr.on("data", (chunk) => { this.stderr = (this.stderr + chunk).slice(-8192); });
    this.child.stdout.on("data", (chunk) => {
      try {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.buffer.length >= 4) {
          const length = this.buffer.readUInt32LE(0);
          if (length > this.frameLimit) throw new Error(`Lab IPC frame budget exceeded: ${length}`);
          if (this.buffer.length < length + 4) break;
          const msg = JSON.parse(this.buffer.subarray(4, length + 4).toString("utf8"));
          this.buffer = this.buffer.subarray(length + 4);
          this.receive(msg);
        }
      } catch (error) { this.fail(error); }
    });
  }

  property(name) {
    return execFileSync("systemctl", ["--user", "show", this.unit, `--property=${name}`, "--value"], { encoding: "utf8", timeout: 3000 }).trim();
  }

  expect(type, id, timeout = 6000) {
    const key = `${type}:${id}`;
    assert(!this.pending.has(key), `Duplicate observer ${key}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`Lab request deadline: ${key}`));
      }, timeout);
      this.pending.set(key, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
  }

  send(message) {
    if (this.failure) throw this.failure;
    const json = Buffer.from(JSON.stringify(message));
    assert(json.length <= this.frameLimit, "Outgoing frame exceeds lab budget");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(json.length);
    this.child.stdin.write(Buffer.concat([header, json]));
  }

  receive(msg) {
    if (this.failure) return; // Late output after failure cannot start new effects.
    if (msg.type === "delegate/request") {
      const controller = new AbortController();
      this.delegates.set(msg.id, controller);
      void (async () => {
        try {
          const value = msg.request.type === "notification/send"
            ? { type: "notification/delivered" }
            : { type: "tool/result", result: await this.invoke(msg.request.invocation, controller.signal) };
          if (!controller.signal.aborted) this.send({ type: "delegate/response", id: msg.id, result: { status: "ok", value } });
        } catch (error) {
          if (!controller.signal.aborted && !this.failure) {
            this.send({ type: "delegate/response", id: msg.id, result: { status: "error", message: String(error) } });
          }
        } finally { this.delegates.delete(msg.id); }
      })().catch((error) => this.fail(error));
      return;
    }
    if (msg.type === "delegate/cancel") { this.delegates.get(msg.id)?.abort(); return; }
    const key = `${msg.type}:${msg.id ?? 0}`;
    const observer = this.pending.get(key);
    if (observer) {
      this.pending.delete(key);
      if (msg.result?.status === "error") observer.reject(new Error(msg.result.message));
      else observer.resolve(msg.result?.value ?? msg);
    } else this.notifications.push(msg);
  }

  fail(error) {
    this.failure ??= error;
    for (const observer of this.pending.values()) observer.reject(this.failure);
    this.pending.clear();
    for (const controller of this.delegates.values()) controller.abort();
  }

  request(request) {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    const response = this.expect("operation/response", id);
    try { this.send({ type: "operation/request", id, request }); }
    catch (error) { this.fail(error); }
    return response;
  }

  start(source, { tools = [], yieldMs = 100, maxTokens = 1000, extra = {} } = {}) {
    if (this.failure) throw this.failure;
    const id = ++this.sequence;
    const started = this.expect("operation/response", id);
    const initial = this.expect("execute/initialResponse", id);
    // Attach rejection handlers immediately; callers may await started first.
    void initial.catch(() => {});
    void started.catch(() => {});
    try {
      this.send({ type: "operation/request", id, request: {
        method: "session/execute", sessionId: this.sessionId,
        request: { tool_call_id: `s0-${id}`, enabled_tools: tools, source, yield_time_ms: yieldMs, max_output_tokens: maxTokens, ...extra },
      } });
    } catch (error) { this.fail(error); }
    return { id, started, initial };
  }

  async execute(source, options) {
    const { started, initial } = this.start(source, options);
    await started;
    return initial;
  }

  async wait(cell, yieldMs = 100) {
    const value = await this.request({ method: "session/wait", sessionId: this.sessionId, request: { cell_id: cell, yield_time_ms: yieldMs } });
    return Object.values(value.outcome)[0];
  }

  async terminate(cell) {
    const value = await this.request({ method: "session/terminate", sessionId: this.sessionId, cellId: cell });
    return Object.values(value.outcome)[0];
  }

  async close() {
    this.fail(new Error("Lab host closed"));
    // Kill the task's entire cgroup, not just the systemd-run proxy.
    try { execFileSync("systemctl", ["--user", "stop", this.unit], { stdio: "ignore", timeout: 5000 }); } catch {}
    this.child.kill("SIGKILL");
    await this.exited;
    try { execFileSync("systemctl", ["--user", "reset-failed", this.unit], { stdio: "ignore", timeout: 5000 }); } catch {}
  }
}
