import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isPiDependency, piFloorArtifacts, piVersion } from "./pi-baselines.mjs";
import { preserveRegistryIntegrity } from "./lock-integrity.mjs";
import { readPnpmLock, writePnpmLock } from "./pnpm-lock.mjs";
import { root, workspaces } from "./workspaces.mjs";
import { baselineCiScripts } from "./pi-ci-policy.mjs";

const selector = process.argv[2] ?? "all";
if (!["all", "floor", "target"].includes(selector) || process.argv.length > 3) {
  throw new Error("usage: test-pi-baselines.mjs [all|floor|target]");
}
const baselines = selector === "all" ? ["floor", "target"] : [selector];
const reuseSetting = process.env.OMP_PI_REUSE_TARGET ?? "0";
assert.ok(["0", "1"].includes(reuseSetting), "OMP_PI_REUSE_TARGET must be 0 or 1");
// A standalone floor role may reuse its required companion target job in CI.
// Local `all` still runs both suites unless explicitly opted in; when opted in,
// only reuse a target suite that actually succeeded in this invocation.
if (selector === "all" && reuseSetting === "1") baselines.reverse();
let targetPassed = false;
const resultsParent = process.env.OMP_PI_MATRIX_LOG_DIR;
if (resultsParent) mkdirSync(resultsParent, { recursive: true });
const results = mkdtempSync(join(resultsParent ?? tmpdir(), "omp-pi-matrix-results-"));
const sourceLock = readPnpmLock(join(root, "pnpm-lock.yaml"));
const files = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" });
assert.equal(files.status, 0, files.stderr);
const tracked = files.stdout.split("\0").filter(Boolean);
const failed = [];
let sourceDigest;
console.log(`Pi matrix logs: ${results}`);

for (const baseline of baselines) {
  const cwd = mkdtempSync(join(tmpdir(), `omp-pi-${baseline}-`));
  const log = join(results, `${baseline}-${piVersion(baseline)}.log`);
  const fd = openSync(log, "w");
  const env = {
    ...process.env, OMP_PI_BASELINE: baseline, PI_OFFLINE: "1", PI_TELEMETRY: "0",
    PI_CODING_AGENT_DIR: join(cwd, ".fixture-agent"),
  };
  const run = (command, args) => {
    const result = spawnSync(command, args, { cwd, env, stdio: ["ignore", fd, fd], timeout: 20 * 60 * 1000 });
    assert.equal(result.status, 0, `${command} ${args.join(" ")} failed; see ${log}`);
  };
  try {
    // Include tracked working-tree edits, not node_modules or arbitrary untracked
    // local configuration. Stage new source files before invoking this command.
    const digest = createHash("sha256");
    for (const file of tracked) {
      const source = join(root, file);
      if (!existsSync(source)) continue;
      assert.ok(lstatSync(source).isFile(), `snapshot requires a regular tracked file: ${file}`);
      digest.update(file).update("\0").update(readFileSync(source)).update("\0");
      const target = resolve(cwd, file);
      assert.ok(target.startsWith(`${cwd}/`));
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
    }
    const fingerprint = digest.digest("hex");
    sourceDigest ??= fingerprint;
    assert.equal(fingerprint, sourceDigest, "source changed between baseline snapshots");
    writeSync(fd, `Node ${process.version}; Pi ${baseline} ${piVersion(baseline)}\nSource SHA-256: ${fingerprint}\n`);
    run("git", ["init", "-b", "main"]);
    const entries = [{ name: "workspace-root", directory: "." }, ...workspaces];
    const manifests = () => entries.map(entry => JSON.parse(readFileSync(join(cwd, entry.directory, "package.json"), "utf8")));
    const sourceManifests = manifests();
    if (baseline === "floor") {
      for (const entry of entries) {
        const path = join(cwd, entry.directory, "package.json");
        const manifest = JSON.parse(readFileSync(path, "utf8"));
        for (const dependency of Object.keys(manifest.devDependencies ?? {})) {
          if (isPiDependency(dependency)) manifest.devDependencies[dependency] = piVersion(baseline);
        }
        writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
      }
      run("pnpm", ["install", "--lockfile-only", "--ignore-scripts", "--no-frozen-lockfile"]);
      const path = join(cwd, "pnpm-lock.yaml");
      const lock = preserveRegistryIntegrity(sourceLock, readPnpmLock(path), piFloorArtifacts);
      writePnpmLock(path, lock);
    }
    run("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"]);
    const scripts = baselineCiScripts({
      baseline, reuseTarget: reuseSetting === "1" && (selector === "floor" || targetPassed),
      sourceLock, projectedLock: readPnpmLock(join(cwd, "pnpm-lock.yaml")),
      sourceManifests, projectedManifests: manifests(),
    });
    if (scripts[0] !== "ci") {
      writeSync(fd, "Identical target/floor manifests and application lock: reusing required companion target behavior tests; retaining installed-SDK, packaging and consumer smoke checks.\n");
      // Even if the caller requested full consumers, reuse only needs a smoke.
      env.OMP_CODEX_CONSUMER_MODE = "smoke";
    }
    for (const script of scripts) run("pnpm", ["run", script]);
    if (baseline === "target") targetPassed = true;
    console.log(`✓ Pi ${baseline} ${piVersion(baseline)}: ${scripts[0] === "ci" ? "CI" : "lock-equivalent target reuse + smoke"} passed (${log})`);
  } catch (error) {
    failed.push(baseline);
    console.error(String(error));
  } finally {
    closeSync(fd);
    rmSync(cwd, { recursive: true, force: true });
  }
}
if (failed.length) throw new Error(`Pi matrix failed: ${failed.join(", ")}; logs preserved at ${results}`);
