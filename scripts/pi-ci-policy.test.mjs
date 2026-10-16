import assert from "node:assert/strict";
import test from "node:test";
import { baselineCiScripts } from "./pi-ci-policy.mjs";

function inputs() {
  const sourceLock = {
    lockfileVersion: "9.0", settings: { autoInstallPeers: true },
    importers: { ".": { devDependencies: { pi: { specifier: "1.2.0", version: "1.2.0" } } } },
    packages: { "pi@1.2.0": { resolution: { integrity: "sha512-fixture", tarball: "https://registry.npmjs.org/pi.tgz" } } },
    snapshots: { "pi@1.2.0": { dependencies: { example: "1.0.0" } } },
  };
  const sourceManifests = [{ name: "workspace", devDependencies: { pi: "1.2.0" } }];
  return {
    baseline: "floor", reuseTarget: true, floorVersion: "1.2.0", targetVersion: "1.2.0",
    sourceLock, projectedLock: structuredClone(sourceLock),
    sourceManifests, projectedManifests: structuredClone(sourceManifests),
  };
}

test("equal installed inputs retain SDK/packaging/consumer checks, not duplicate behavior", () => {
  assert.deepEqual(baselineCiScripts(inputs()), ["check:pi-baseline", "pack:check", "test:codex-packages"]);
});

test("default, target, and different version roles always run complete CI", () => {
  for (const patch of [{ reuseTarget: false }, { reuseTarget: undefined }, { baseline: "target" }, { targetVersion: "1.3.0" }]) {
    assert.deepEqual(baselineCiScripts({ ...inputs(), ...patch }), ["ci"]);
  }
  assert.throws(() => baselineCiScripts({ ...inputs(), baseline: "latest" }), /Unknown Pi baseline/);
});

test("lock, graph, integrity, manifest or policy drift forces full CI", () => {
  for (const mutate of [
    p => { p.projectedLock.importers["."].devDependencies.pi.version = "1.2.1"; },
    p => { p.projectedLock.packages["pi@1.2.0"].resolution.integrity = "sha512-changed"; },
    p => { p.projectedLock.packages["pi@1.2.0"].resolution.tarball += "?changed"; },
    p => { p.projectedLock.snapshots["pi@1.2.0"].dependencies.example = "2.0.0"; },
    p => { p.projectedLock.settings.autoInstallPeers = false; },
    p => { p.projectedManifests[0].devDependencies.pi = "1.2.1"; },
    p => { p.projectedManifests.push({ name: "extra" }); },
    p => { p.projectedLock.extraPolicy = true; },
  ]) {
    const policy = inputs();
    mutate(policy);
    assert.deepEqual(baselineCiScripts(policy), ["ci"]);
  }
});

test("missing lock or manifests cannot establish equivalence", () => {
  for (const patch of [
    { sourceLock: undefined, projectedLock: undefined },
    { sourceLock: {}, projectedLock: {} },
    { sourceManifests: [], projectedManifests: [] },
    { sourceManifests: undefined, projectedManifests: undefined },
  ]) assert.deepEqual(baselineCiScripts({ ...inputs(), ...patch }), ["ci"]);
});
