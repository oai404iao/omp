import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { digest } from "./release-consumer-artifacts.mjs";
import { assertContainedTree, installConsumers, run } from "./release-consumer-install.mjs";
import { readPnpmLock } from "./pnpm-lock.mjs";
import { root } from "./workspaces.mjs";

const parent = join(homedir(), ".local/state/agents/tmp");
mkdirSync(parent, { recursive: true });
function scratch(t) {
  const directory = mkdtempSync(join(parent, "release-consumer-install-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("containment rejects external links including executable links", t => {
  const directory = scratch(t); const outside = scratch(t);
  mkdirSync(join(directory, "node_modules/.bin"), { recursive: true });
  writeFileSync(join(outside, "cli"), "outside");
  symlinkSync(join(outside, "cli"), join(directory, "node_modules/.bin/leak"));
  assert.throws(() => assertContainedTree(join(directory, "node_modules"), directory), /external link/);
});

test("loader probe rejects an SDK linked outside an aliased consumer", t => {
  const directory = scratch(t);
  const consumer = join(directory, "consumer");
  const outside = join(directory, "consumer-outside");
  const alias = join(directory, "alias");
  mkdirSync(join(consumer, "node_modules/@earendil-works"), { recursive: true });
  mkdirSync(outside);
  symlinkSync(consumer, alias, "dir");
  symlinkSync(outside, join(consumer, "node_modules/@earendil-works/pi-coding-agent"), "dir");
  const job = join(consumer, "loader-job.json");
  writeFileSync(job, JSON.stringify({ cwd: alias }));
  const probe = fileURLToPath(new URL("./release-consumer-probe.mjs", import.meta.url));
  assert.throws(() => run(process.execPath, [probe, job], alias), /external link/);
});

test("offline immutable fixture really installs and executes its isolated Pi SDK loader through a directory alias", t => {
  const directory = scratch(t);
  const consumer = join(directory, "real-consumer-root");
  const alias = join(directory, "alias");
  mkdirSync(consumer);
  symlinkSync(consumer, alias, "dir");
  const name = "@oai404iao/pi-notify";
  const sourceCommit = "a".repeat(40);
  const manifest = { name, version: "1.0.0", type: "module", gitHead: sourceCommit,
    peerDependencies: { "@earendil-works/pi-coding-agent": ">=1.2.0" }, pi: { extensions: ["./index.ts"] } };
  mkdirSync(join(directory, "package"));
  writeFileSync(join(directory, "package/package.json"), JSON.stringify(manifest));
  writeFileSync(join(directory, "package/index.ts"), `export default pi => {
  for (const name of ["notify", "notify-test"]) {
    pi.registerCommand(name, { description: "offline fixture", handler: async () => {} });
  }
};`);
  const path = join(directory, "fixture.tgz");
  assert.equal(spawnSync("tar", ["-czf", path, "package/"], { cwd: directory }).status, 0);
  const artifacts = new Map([[name, { path, integrity: digest(readFileSync(path)) }]]);
  const consumers = installConsumers([{ name, sourceCommit }], new Map([[name, manifest]]), artifacts,
    readPnpmLock(join(root, "pnpm-lock.yaml")), alias);
  assert.equal(consumers.length, 1);
  assert.deepEqual(consumers[0].included, [name]);
});

for (const broken of [false, true]) {
  test(`runtime-only offline consumers on a long path ${broken ? "reject a broken entry" : "execute contained public exports"}`, t => {
    const directory = join(scratch(t), "long-consumer-root-".repeat(8));
    const name = "@oai404iao/pi-codex-runtime";
    const sourceCommit = "a".repeat(40);
    const manifest = { name, version: "1.0.0", type: "module", gitHead: sourceCommit,
      exports: { ".": "./index.ts", "./subagent-inline": "./inline.ts" },
      peerDependencies: { "@earendil-works/pi-coding-agent": ">=1.2.0" } };
    mkdirSync(join(directory, "package"), { recursive: true });
    writeFileSync(join(directory, "package/package.json"), JSON.stringify(manifest));
    writeFileSync(join(directory, "package/index.ts"), broken ? `throw new Error("broken runtime export");` : `
export function getCodexBroker() {}
export function addPackageTool() {}
export function ensureCodexServices() {}
export const CODEX_BROKER_CHANNEL = "@oai404iao/pi-codex:broker";
export const CODEX_RUNTIME_VERSION = "1.0.0";`);
    writeFileSync(join(directory, "package/inline.ts"), `
export const CODEX_IDENTITY_CUSTOM_TYPE = "fixture";
export function createCodexSubagentInlineExtension() {}`);
    const path = join(directory, "runtime.tgz");
    assert.equal(spawnSync("tar", ["-czf", path, "package/"], { cwd: directory }).status, 0);
    const artifacts = new Map([[name, { path, integrity: digest(readFileSync(path)) }]]);
    const install = () => installConsumers([{ name, sourceCommit }], new Map([[name, manifest]]), artifacts,
      readPnpmLock(join(root, "pnpm-lock.yaml")), directory);
    if (broken) assert.throws(install, /broken runtime export/);
    else assert.deepEqual(install()[0].included, [name]);
  });
}
