import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { digest } from "./release-consumer-artifacts.mjs";
import { assertContainedTree, installConsumers } from "./release-consumer-install.mjs";
import { readPnpmLock } from "./pnpm-lock.mjs";
import { root } from "./workspaces.mjs";

const parent = join(homedir(), ".local/state/agents/tmp");
mkdirSync(parent, { recursive: true });
const scratch = () => mkdtempSync(join(parent, "release-consumer-install-test-"));

test("containment rejects external links including executable links", () => {
  const directory = scratch(); const outside = scratch();
  mkdirSync(join(directory, "node_modules/.bin"), { recursive: true });
  writeFileSync(join(outside, "cli"), "outside");
  symlinkSync(join(outside, "cli"), join(directory, "node_modules/.bin/leak"));
  assert.throws(() => assertContainedTree(join(directory, "node_modules"), directory), /external link/);
});

test("offline immutable fixture really installs and executes its isolated Pi SDK loader", () => {
  const directory = scratch();
  const name = "@oai404iao/pi-telegram-notify";
  const sourceCommit = "a".repeat(40);
  const manifest = { name, version: "1.0.0", type: "module", gitHead: sourceCommit,
    peerDependencies: { "@earendil-works/pi-coding-agent": ">=1.2.0" }, pi: { extensions: ["./index.ts"] } };
  mkdirSync(join(directory, "package"));
  writeFileSync(join(directory, "package/package.json"), JSON.stringify(manifest));
  writeFileSync(join(directory, "package/index.ts"), `export default pi => { pi.registerCommand("telegram-notify", {description: "offline fixture", handler: async () => {}}); };`);
  const path = join(directory, "fixture.tgz");
  assert.equal(spawnSync("tar", ["-czf", path, "package/"], { cwd: directory }).status, 0);
  const artifacts = new Map([[name, { path, integrity: digest(readFileSync(path)) }]]);
  const consumers = installConsumers([{ name, sourceCommit }], new Map([[name, manifest]]), artifacts,
    readPnpmLock(join(root, "pnpm-lock.yaml")), directory);
  assert.equal(consumers.length, 1);
  assert.deepEqual(consumers[0].included, [name]);
});

test("runtime-only offline consumers execute contained public exports and reject a broken entry", () => {
  for (const broken of [false, true]) {
    const directory = scratch();
    const name = "@oai404iao/pi-codex-runtime";
    const sourceCommit = "a".repeat(40);
    const manifest = { name, version: "1.0.0", type: "module", gitHead: sourceCommit,
      exports: { ".": "./index.ts", "./subagent-inline": "./inline.ts" },
      peerDependencies: { "@earendil-works/pi-coding-agent": ">=1.2.0" } };
    mkdirSync(join(directory, "package"));
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
  }
});
