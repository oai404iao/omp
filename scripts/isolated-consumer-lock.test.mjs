import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { isolatedConsumerLock } from "./isolated-consumer-lock.mjs";
import { preserveRegistryIntegrity } from "./lock-integrity.mjs";
import { sourceConsumerSelection } from "./codex-consumer-matrix.mjs";
import { readPnpmLock, writePnpmLock } from "./pnpm-lock.mjs";
import { root } from "./workspaces.mjs";

const entry = (version, name = "lib") => ({
  resolution: {
    tarball: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
    integrity: "sha512-fixture",
  },
});
const core = "@oai404iao/pi-codex-core";
const runtime = "@oai404iao/pi-codex-runtime";
function fixture() {
  const manifests = new Map([
    [core, { version: "0.1.0", dependencies: { lib: "2", [runtime]: "1" }, peerDependencies: { host: "1" } }],
    [runtime, { version: "1.0.0", peerDependencies: { host: "1" }, peerDependenciesMeta: { host: { optional: true } } }],
  ]);
  const artifacts = new Map([
    [core, { path: "/fixtures/core.tgz", integrity: "sha512-core" }],
    [runtime, { path: "/fixtures/runtime.tgz", integrity: "sha512-runtime" }],
  ]);
  const source = {
    lockfileVersion: "9.0",
    settings: { autoInstallPeers: false, excludeLinksFromLockfile: false },
    importers: {
      ".": { devDependencies: { host: { specifier: "1", version: "1(lib@1)" } } },
      "pi-extensions/pi-codex-core": { dependencies: {
        lib: { specifier: "2", version: "2" },
        [runtime]: { specifier: "1", version: "link:../pi-codex-runtime" },
      } },
      "pi-extensions/pi-codex-runtime": {},
    },
    packages: {
      "lib@1": entry("1"), "lib@2": entry("2"),
      "dev-only@9": entry("9", "dev-only"),
      "host@1": { ...entry("1", "host"), peerDependencies: { lib: "1" } },
    },
    snapshots: {
      "lib@1": {}, "lib@2": {}, "dev-only@9": {},
      "host@1(lib@1)": { dependencies: { lib: "1" } },
    },
  };
  return { manifests, artifacts, source, project: () => isolatedConsumerLock("fixture", [core, runtime], manifests, artifacts, source) };
}

test("consumer lock projects production/peer closure with exact artifacts and distinct dependency versions", () => {
  const { source, project } = fixture();
  const original = structuredClone(source);
  const { manifest, workspace, lock } = project();
  assert.ok(!lock.packages["dev-only@9"]);
  assert.deepEqual(lock.packages["lib@1"], source.packages["lib@1"]);
  assert.deepEqual(lock.packages["lib@2"], source.packages["lib@2"]);
  assert.deepEqual(lock.snapshots["host@1(lib@1)"], source.snapshots["host@1(lib@1)"]);
  assert.equal(lock.packages[`${core}@file:/fixtures/core.tgz`].resolution.integrity, "sha512-core");
  assert.equal(lock.snapshots[`${core}@file:/fixtures/core.tgz(host@1(lib@1))`].dependencies.lib, "2");
  assert.equal(lock.snapshots[`${core}@file:/fixtures/core.tgz(host@1(lib@1))`].dependencies[runtime],
    "file:/fixtures/runtime.tgz(host@1(lib@1))");
  assert.equal(lock.snapshots[`${runtime}@file:/fixtures/runtime.tgz(host@1(lib@1))`].optionalDependencies.host, "1(lib@1)");
  assert.deepEqual(lock.overrides, workspace.overrides);
  assert.equal(manifest.dependencies.host, "1");
  assert.equal(lock.importers["."].dependencies.host.version, "1(lib@1)");
  assert.deepEqual(source, original, "projection must not modify the reviewed lock");
});

test("consumer lock rejects linked, unpinned and non-registry external artifacts", () => {
  for (const mutate of [
    source => { source.importers["."].devDependencies.host.version = "link:../host"; },
    source => { delete source.packages["host@1"].resolution.integrity; },
    source => { source.packages["host@1"].resolution.type = "directory"; },
  ]) {
    const { source, project } = fixture();
    mutate(source);
    assert.throws(project, /linked external/);
  }
  const { source, project } = fixture();
  source.packages["host@1"].resolution.tarball = "https://unreviewed.example/host.tgz";
  assert.throws(project, /not a locked registry artifact/);
});

test("source projection keeps an older locked dependency even beside a local tarball of the same package", () => {
  const { manifests, artifacts, source } = fixture();
  source.importers["pi-extensions/pi-codex-core"].dependencies[runtime] = { specifier: "^0.9.0", version: "0.9.1" };
  manifests.get(core).dependencies[runtime] = "^0.9.0";
  source.packages[`${runtime}@0.9.1`] = entry("0.9.1", runtime);
  source.snapshots[`${runtime}@0.9.1`] = {};
  const { lock } = isolatedConsumerLock("fixture", [core, runtime], manifests, artifacts, source, new Set([`${core}>${runtime}`]));
  assert.equal(lock.snapshots[`${core}@file:/fixtures/core.tgz(host@1(lib@1))`].dependencies[runtime], "0.9.1");
  assert.deepEqual(lock.packages[`${runtime}@0.9.1`], source.packages[`${runtime}@0.9.1`]);
  assert.equal(lock.packages[`${runtime}@file:/fixtures/runtime.tgz`].resolution.integrity, "sha512-runtime");
  assert.equal(lock.overrides[runtime], undefined);
});

test("frozen pnpm resolves each source archive to its own compatible local or locked registry dependency", t => {
  const cwd = mkdtempSync(join(tmpdir(), "mixed-source-install-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const source = readPnpmLock(join(root, "pnpm-lock.yaml"));
  const pinned = source.importers["."].devDependencies.yaml.version;
  const old = "@fixture/older", next = "@fixture/newer";
  const newer = `${Number(pinned.split(".")[0]) + 1}.0.0`;
  const manifests = new Map([
    [old, { name: old, version: "1.0.0", dependencies: { yaml: `^${pinned}` } }],
    [next, { name: next, version: "1.0.0", dependencies: { yaml: `^${newer}` } }],
    ["yaml", { name: "yaml", version: newer }],
  ]);
  source.importers["pi-extensions/older"] = { dependencies: { yaml: { specifier: `^${pinned}`, version: pinned } } };
  const artifacts = new Map();
  mkdirSync(join(cwd, "package"));
  for (const [name, manifest] of manifests) {
    writeFileSync(join(cwd, "package/package.json"), JSON.stringify(manifest));
    const path = join(cwd, `${name.split("/").at(-1)}.tgz`);
    execFileSync("tar", ["-czf", path, "package/"], { cwd });
    artifacts.set(name, { path, integrity: `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}` });
  }
  const { included, resolutions } = sourceConsumerSelection([old, next], manifests, source);
  const result = isolatedConsumerLock("isolated", included, manifests, artifacts, source,
    new Set(resolutions.map(({ owner, dependency }) => `${owner}>${dependency}`)));
  writeFileSync(join(cwd, "package.json"), JSON.stringify(result.manifest));
  writeFileSync(join(cwd, "pnpm-workspace.yaml"), stringify(result.workspace));
  writePnpmLock(join(cwd, "pnpm-lock.yaml"), result.lock);
  const store = execFileSync("pnpm", ["store", "path", "--silent"], { cwd: root, encoding: "utf8" }).trim();
  execFileSync("pnpm", ["install", "--store-dir", store, "--offline", "--prod", "--frozen-lockfile", "--trust-lockfile", "--ignore-scripts"], { cwd });
  for (const [name, expected] of [[old, pinned], [next, newer]]) {
    const require = createRequire(realpathSync(join(cwd, "node_modules", name, "package.json")));
    assert.ok(realpathSync(require.resolve("yaml/package.json")).startsWith(`${cwd}/`));
    assert.equal(require("yaml/package.json").version, expected);
  }
});

test("consumer lock retains alias, optional and peer-context dependency edges", () => {
  const { source, project } = fixture();
  source.snapshots["lib@2"] = { dependencies: { alias: "real@3(peer@1)" }, optionalDependencies: { optional: "4" } };
  source.packages["real@3"] = { ...entry("3", "real"), peerDependencies: { peer: "*" } };
  source.snapshots["real@3(peer@1)"] = { dependencies: { peer: "1" } };
  source.packages["peer@1"] = entry("1", "peer");
  source.snapshots["peer@1"] = {};
  source.packages["optional@4"] = { ...entry("4", "optional"), os: ["darwin"] };
  source.snapshots["optional@4"] = { optional: true };
  const { lock } = project();
  assert.deepEqual(lock.snapshots["real@3(peer@1)"], source.snapshots["real@3(peer@1)"]);
  assert.deepEqual(lock.packages["optional@4"], source.packages["optional@4"]);
  assert.deepEqual(lock.snapshots["optional@4"], { optional: true });
  delete source.snapshots["real@3(peer@1)"].dependencies.peer;
  assert.throws(project, /Missing locked dependency/);
  source.packages["real@3"].peerDependenciesMeta = { peer: { optional: true } };
  assert.doesNotThrow(project);
});

test("consumer lock rejects missing closure members, host peers and workspace artifacts", () => {
  for (const [mutate, error] of [
    [({ source }) => { delete source.snapshots["lib@2"]; }, /Missing locked dependency/],
    [({ source }) => { delete source.importers["."].devDependencies.host; }, /Missing locked Pi host peer/],
    [({ artifacts }) => { artifacts.delete(runtime); }, /Missing packed workspace artifact/],
  ]) {
    const state = fixture();
    mutate(state);
    assert.throws(state.project, error);
  }
  const { manifests, artifacts, source } = fixture();
  assert.throws(() => isolatedConsumerLock("fixture", [core], manifests, artifacts, source), /Missing packed workspace dependency/);
});

test("lost hashes can only be restored from the same locked URL and version", () => {
  const previous = { packages: { "lib@1": entry("1") } };
  const missing = entry("1");
  delete missing.resolution.integrity;
  assert.equal(preserveRegistryIntegrity(previous, { packages: { "lib@1": missing } }).packages["lib@1"].resolution.integrity, "sha512-fixture");
  const changed = entry("1");
  changed.resolution.integrity = "sha512-other";
  assert.throws(() => preserveRegistryIntegrity(previous, { packages: { "lib@1": changed } }), /integrity changed/);
  const upgraded = entry("2");
  delete upgraded.resolution.integrity;
  assert.throws(() => preserveRegistryIntegrity(previous, { packages: { "lib@2": upgraded } }), /Missing reviewed/);
});
