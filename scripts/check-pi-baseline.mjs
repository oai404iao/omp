import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { root, workspaces } from "./workspaces.mjs";
import { isPiDependency, piVersion } from "./pi-baselines.mjs";

for (const entry of [{ directory: ".", name: "workspace-root" }, ...workspaces]) {
  const directory = join(root, entry.directory);
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  const require = createRequire(join(directory, "package.json"));
  for (const [dependency, declared] of Object.entries(manifest.devDependencies ?? {})) {
    if (!isPiDependency(dependency)) continue;
    const expected = piVersion();
    assert.equal(declared, expected, `${entry.name}: declared Pi development version`);
    const path = require.resolve.paths(dependency).map(base => join(base, dependency, "package.json")).find(existsSync);
    assert.ok(path, `${entry.name}: missing ${dependency}`);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).version, expected,
      `${entry.name}: ${dependency} must resolve to its tested version, not a hoisted alternative`);
  }
}

const temporary = mkdtempSync(join(tmpdir(), "omp-pi-smoke-"));
try {
  const env = {
    PATH: process.env.PATH, HOME: temporary, TMPDIR: tmpdir(), LANG: "C.UTF-8",
    PI_CODING_AGENT_DIR: join(temporary, "agent"), PI_OFFLINE: "1", PI_TELEMETRY: "0",
    OMP_PI_BASELINE: process.env.OMP_PI_BASELINE ?? "target",
  };
  const probe = spawnSync(process.execPath, [join(root, "scripts/pi-loader-smoke.mjs")], {
    cwd: root, encoding: "utf8", env, timeout: 60000,
  });
  assert.equal(probe.status, 0, probe.stdout + probe.stderr);
  const cli = spawnSync(process.execPath, [
    join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
    "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates",
    "--no-context-files", "--no-themes", "--no-approve",
    "-e", join(root, "pi-extensions/pi-codex-minimal-tools/src/index.ts"), "--list-models",
  ], { cwd: temporary, encoding: "utf8", env, timeout: 60000 });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.doesNotMatch(cli.stdout + cli.stderr, /Failed to load extension|ERR_MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED/);
  console.log(`✓ Pi ${piVersion()}: resolved workspace peers, private-hook loader probe and offline CLI smoke`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
