// Repository-only S0 experiment. No downloads, credentials or package activation.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, chmodSync, createWriteStream, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const lock = JSON.parse(readFileSync(new URL("./host-lock.json", import.meta.url), "utf8"));
const args = process.argv.slice(2);
assert(args.length === 2 && args[0] === "--archive", "Usage: node scripts/code-mode-s0/run.mjs --archive /absolute/path/to/pinned.tar.gz");
assert.equal(`${process.platform}-${process.arch}`, lock.platform, "S0 requires Linux x64 with a user systemd/cgroup v2 manager");
const archive = resolve(args[1]);
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
assert.equal(hash(archive), lock.archiveSha256, "Host archive digest mismatch; refusing extraction/execution");
assert.equal(execFileSync("tar", ["-tzf", archive], { encoding: "utf8", timeout: 30000 }).trim(), lock.entry, "Unexpected archive entries");
execFileSync("systemctl", ["--user", "show-environment"], { stdio: "ignore", timeout: 3000 });
assert(readFileSync("/sys/fs/cgroup/cgroup.controllers", "utf8").split(/\s+/).includes("memory"), "cgroup v2 memory controller is required");

// Resolve the real scratch root before rebinding HOME/XDG in the child.
const root = join(homedir(), ".local/state/agents/tmp");
mkdirSync(root, { recursive: true, mode: 0o700 });
const dir = mkdtempSync(join(root, "code-mode-s0-"));
chmodSync(dir, 0o700);
for (const name of ["home", "agent", "cache", "config", "data", "state"]) mkdirSync(join(dir, name), { mode: 0o700 });
execFileSync("tar", ["-xzf", archive, "--no-same-owner", "--no-same-permissions", "-C", dir], { timeout: 30000 });
const binary = join(dir, lock.entry);
assert.equal(hash(binary), lock.binarySha256, "Extracted binary digest mismatch");
chmodSync(binary, 0o700);
const evidence = {
  lock, archiveSha256: hash(archive), binarySha256: hash(binary),
  node: process.version, platform: process.platform, arch: process.arch,
  pi: JSON.parse(readFileSync(new URL("../../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url))).version,
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", timeout: 3000 }).trim(),
  rootLockSha256: hash(new URL("../../package-lock.json", import.meta.url)),
  sources: Object.fromEntries(readdirSync(import.meta.dirname)
    .filter((name) => name.endsWith(".mjs") || name === "host-lock.json").sort()
    .map((name) => [name, hash(new URL(name, import.meta.url))])),
  startedAt: new Date().toISOString(),
};
console.log(`S0 evidence directory: ${dir}`);
writeFileSync(join(dir, "manifest.json"), JSON.stringify(evidence, null, 2) + "\n");
const env = {
  PATH: process.env.PATH, HOME: join(dir, "home"), TMPDIR: dir,
  XDG_CONFIG_HOME: join(dir, "config"), XDG_CACHE_HOME: join(dir, "cache"),
  XDG_DATA_HOME: join(dir, "data"), XDG_STATE_HOME: join(dir, "state"),
  PI_CODING_AGENT_DIR: join(dir, "agent"), PI_OFFLINE: "1",
  CODE_MODE_S0_DIR: dir, CODE_MODE_S0_HOST: binary,
};
for (const key of ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) {
  if (process.env[key]) env[key] = process.env[key];
}
const files = ["bridge.test.mjs", "host.test.mjs", "pi-boundary.test.mjs"];
const child = spawn(process.execPath, [
  "--test", "--test-concurrency=1", "--test-reporter=tap",
  ...files.map((name) => new URL(name, import.meta.url).pathname),
], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
const log = createWriteStream(join(dir, "tests.tap"));
let stopReason;
let forceTimer;
const signalGroup = (signal) => {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== "ESRCH") console.error(error); }
};
const stop = (reason) => {
  if (stopReason) return;
  stopReason = reason;
  signalGroup("SIGTERM");
  forceTimer = setTimeout(() => signalGroup("SIGKILL"), 1000);
};
const deadline = setTimeout(() => stop("120s experiment deadline"), 120000);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop(signal));
child.stdout.on("data", (data) => { process.stdout.write(data); log.write(data); });
child.stderr.on("data", (data) => { process.stderr.write(data); log.write(data); });
child.on("error", (error) => { console.error(error); });
child.on("close", (code, signal) => {
  clearTimeout(deadline);
  clearTimeout(forceTimer);
  // Even after abnormal runner exit, never sweep unrelated user services.
  let cleanupError;
  const unitsPath = join(dir, "units.jsonl");
  const units = existsSync(unitsPath) ? readFileSync(unitsPath, "utf8").trim().split("\n")
    .filter(Boolean).map((line) => JSON.parse(line).unit) : [];
  assert(units.every((unit) => /^omp-code-mode-s0-[a-f0-9-]{36}\.service$/.test(unit)));
  if (stopReason && units.length) {
    try { execFileSync("systemctl", ["--user", "stop", ...units], { stdio: "ignore", timeout: 5000 }); }
    catch (error) { cleanupError = error.message; }
  }
  log.end();
  writeFileSync(join(dir, "result.json"), JSON.stringify({ code, signal, stopReason, cleanupError, endedAt: new Date().toISOString() }, null, 2) + "\n");
  process.exitCode = stopReason ? 1 : (code ?? 1);
});
