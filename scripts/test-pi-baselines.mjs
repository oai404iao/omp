import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isPiDependency, piFloorArtifacts, piVersion } from "./pi-baselines.mjs";
import { preserveRegistryIntegrity } from "./lock-integrity.mjs";
import { root, workspaces } from "./workspaces.mjs";

const selector = process.argv[2] ?? "all";
if (!["all", "floor", "target"].includes(selector) || process.argv.length > 3) {
  throw new Error("usage: test-pi-baselines.mjs [all|floor|target]");
}
const baselines = selector === "all" ? ["floor", "target"] : [selector];
const resultsParent = process.env.OMP_PI_MATRIX_LOG_DIR;
if (resultsParent) mkdirSync(resultsParent, { recursive: true });
const results = mkdtempSync(join(resultsParent ?? tmpdir(), "omp-pi-matrix-results-"));
const sourceLock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
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
    if (baseline === "floor") {
      for (const entry of [{ name: "workspace-root", directory: "." }, ...workspaces]) {
        const path = join(cwd, entry.directory, "package.json");
        const manifest = JSON.parse(readFileSync(path, "utf8"));
        for (const dependency of Object.keys(manifest.devDependencies ?? {})) {
          if (isPiDependency(dependency)) manifest.devDependencies[dependency] = piVersion(baseline);
        }
        writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
      }
      run("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"]);
      const path = join(cwd, "package-lock.json");
      const lock = preserveRegistryIntegrity(sourceLock, JSON.parse(readFileSync(path, "utf8")), piFloorArtifacts);
      writeFileSync(path, `${JSON.stringify(lock, null, 2)}\n`);
    }
    run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
    run("npm", ["run", "ci"]);
    console.log(`✓ Pi ${baseline} ${piVersion(baseline)}: complete CI passed (${log})`);
  } catch (error) {
    failed.push(baseline);
    console.error(String(error));
  } finally {
    closeSync(fd);
    rmSync(cwd, { recursive: true, force: true });
  }
}
if (failed.length) throw new Error(`Pi matrix failed: ${failed.join(", ")}; logs preserved at ${results}`);
