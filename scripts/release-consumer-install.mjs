import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { piVersion } from "./pi-baselines.mjs";
import { writePnpmLock } from "./pnpm-lock.mjs";
import { releaseConsumerCases, releaseConsumerLock } from "./release-consumer-lock.mjs";
import { root } from "./workspaces.mjs";

export function run(command, args, cwd, env) {
  const result = spawnSync(command, args, { cwd, env: { ...process.env, ...env, NODE_PATH: "", NODE_OPTIONS: "",
    npm_config_audit: "false", npm_config_fund: "false" }, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}\n${result.error ?? ""}`);
  return result.stdout;
}

export function assertContainedTree(path, consumer) {
  const base = `${realpathSync(consumer)}/`;
  for (const entry of readdirSync(path)) {
    const file = join(path, entry);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) assert.ok(realpathSync(file).startsWith(base), `external link: ${file}`);
    else if (stat.isDirectory()) assertContainedTree(file, consumer);
  }
}

export function installConsumers(candidates, manifests, artifacts, sourceLock, directory, runner = run) {
  const store = runner("pnpm", ["store", "path", "--silent"], root, { TMPDIR: directory }).trim();
  if (!store || !resolve(store).startsWith("/")) throw new Error("Cannot resolve pnpm artifact store");
  const cases = releaseConsumerCases(candidates, manifests);
  for (const item of cases) {
    const cwd = join(directory, item.label);
    mkdirSync(cwd);
    const fixture = releaseConsumerLock(`release-${item.label}`, item.included, manifests, artifacts, sourceLock);
    writeFileSync(join(cwd, "package.json"), JSON.stringify(fixture.manifest));
    writeFileSync(join(cwd, "pnpm-workspace.yaml"), stringify(fixture.workspace));
    writePnpmLock(join(cwd, "pnpm-lock.yaml"), fixture.lock);
    const frozenBytes = readFileSync(join(cwd, "pnpm-lock.yaml"));
    const agent = join(cwd, "agent");
    mkdirSync(agent);
    const env = { TMPDIR: directory, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0" };
    // Only verified, already checksummed local archives may enter the store.
    runner("pnpm", ["store", "add", ...[...item.included].map(name => `file:${artifacts.get(name).path}`),
      "--store-dir", store, "--offline"], cwd, env);
    runner("pnpm", ["install", "--store-dir", store, "--offline", "--prod", "--frozen-lockfile",
      "--trust-lockfile", "--ignore-scripts"], cwd, env);
    assert.deepEqual(readFileSync(join(cwd, "pnpm-lock.yaml")), frozenBytes, "frozen installation mutated the fixture lock");
    assertContainedTree(join(cwd, "node_modules"), cwd);
    assert.deepEqual(readdirSync(join(cwd, "node_modules/@oai404iao")).sort(),
      [...item.included].map(name => name.split("/").at(-1)).sort(), "installed candidate closure mismatch");
    for (const name of item.included) {
      const installed = JSON.parse(readFileSync(join(cwd, "node_modules", name, "package.json")));
      assert.equal(installed.name, name);
      assert.equal(installed.version, manifests.get(name).version);
      assert.equal(installed.gitHead, candidates.find(c => c.name === name).sourceCommit);
    }
    const job = join(cwd, "loader-job.json");
    writeFileSync(job, JSON.stringify({ cwd, version: piVersion(), manifests: Object.fromEntries(manifests),
      orders: item.requested.length > 1 ? [item.requested, [...item.requested].reverse()] : [item.requested] }));
    runner(process.execPath, [fileURLToPath(new URL("./release-consumer-probe.mjs", import.meta.url)), job], cwd, env);
    if (item.included.has("@oai404iao/pi-codex-runtime")) {
      const smoke = join(cwd, "runtime-smoke.mts");
      writeFileSync(smoke, `import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
globalThis.fetch = async () => { throw new Error("Network is forbidden in runtime smoke"); };
const require = createRequire(import.meta.url);
const consumer = realpathSync(dirname(fileURLToPath(import.meta.url)));
for (const entry of ["@oai404iao/pi-codex-runtime", "@oai404iao/pi-codex-runtime/subagent-inline"]) {
  assert.ok(realpathSync(require.resolve(entry)).startsWith(consumer + "/"), "runtime export escaped the consumer");
}
const runtime = await import("@oai404iao/pi-codex-runtime");
const inline = await import("@oai404iao/pi-codex-runtime/subagent-inline");
for (const key of ["getCodexBroker", "addPackageTool", "ensureCodexServices"]) assert.equal(typeof runtime[key], "function", key);
assert.equal(runtime.CODEX_BROKER_CHANNEL, "@oai404iao/pi-codex:broker");
assert.equal(runtime.CODEX_RUNTIME_VERSION, ${JSON.stringify(manifests.get("@oai404iao/pi-codex-runtime").version)});
assert.equal(typeof inline.createCodexSubagentInlineExtension, "function");
assert.equal(typeof inline.CODEX_IDENTITY_CUSTOM_TYPE, "string");`);
      runner(join(root, "node_modules/.bin/tsx"), [smoke], cwd, env);
    }
    if (item.included.has("@oai404iao/pi-codex-minimal-tools")) {
      const smoke = join(cwd, "inline-smoke.mts");
      writeFileSync(smoke, `import assert from "node:assert/strict";
import * as bundle from "@oai404iao/pi-codex-minimal-tools/subagent-inline";
import * as runtime from "@oai404iao/pi-codex-runtime/subagent-inline";
assert.deepEqual(Object.keys(bundle).sort(), ["CODEX_IDENTITY_CUSTOM_TYPE", "createCodexSubagentInlineExtension"]);
assert.equal(bundle.createCodexSubagentInlineExtension, runtime.createCodexSubagentInlineExtension);`);
      runner(join(root, "node_modules/.bin/tsx"), [smoke], cwd, env);
    }
    assertContainedTree(join(cwd, "node_modules"), cwd);
  }
  return cases.map(({ label, requested, included }) => ({ label, requested, included: [...included] }));
}
