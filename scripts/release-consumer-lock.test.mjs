import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseConsumerCases, releaseConsumerLock } from "./release-consumer-lock.mjs";

function fixture() {
  const a = "@oai404iao/a", b = "@oai404iao/b";
  const manifests = new Map([[a, { name: a, version: "1.0.0", dependencies: { [b]: "1.0.0", external: "^1.0.0" },
    peerDependencies: { sdk: ">=1.0.0" } }], [b, { name: b, version: "1.0.0" }]]);
  const artifacts = new Map([a, b].map(name => [name, { path: `/immutable/${name.at(-1)}.tgz`, integrity: "sha512-fixture" }]));
  const lock = { lockfileVersion: "9.0", settings: {}, importers: {
    ".": { devDependencies: { sdk: { specifier: "1.0.0", version: "1.0.0" } } },
    "pi-extensions/a": { dependencies: { external: { specifier: "^1.0.0", version: "1.0.0" } } },
  }, packages: {}, snapshots: {} };
  for (const name of ["sdk", "external"]) {
    lock.packages[`${name}@1.0.0`] = { resolution: { integrity: "sha512-external", tarball: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz` } };
    lock.snapshots[`${name}@1.0.0`] = {};
  }
  return { a, b, manifests, artifacts, lock };
}

test("historical contracts project only local immutable tarballs and locked externals", () => {
  const f = fixture();
  const projected = releaseConsumerLock("fixture", new Set([f.a, f.b]), f.manifests, f.artifacts, f.lock);
  assert.equal(projected.manifest.dependencies[f.a], "file:/immutable/a.tgz");
  assert.equal(projected.lock.packages["external@1.0.0"].resolution.integrity, "sha512-external");
  assert.equal(projected.workspace.autoInstallPeers, false);
});

test("external dependency specifier, resolution, host peer or unlocked prerequisites fail", () => {
  for (const mutate of [f => f.lock.importers["pi-extensions/a"].dependencies.external.specifier = "^2.0.0",
    f => f.lock.importers["pi-extensions/a"].dependencies.external.version = "2.0.0",
    f => f.lock.importers["."].devDependencies.sdk.version = "0.9.0",
    f => delete f.lock.snapshots["external@1.0.0"],
    f => f.lock.packages["external@1.0.0"].resolution.tarball = "https://evil.invalid/t.tgz",
    f => f.lock.importers["pi-extensions/a"].dependencies.external.version = "link:../external"]) {
    const f = fixture(); mutate(f);
    assert.throws(() => releaseConsumerLock("fixture", new Set([f.a, f.b]), f.manifests, f.artifacts, f.lock));
  }
});

test("targeted or batch consumers cover each candidate closure and combined orders", () => {
  const f = fixture();
  const targeted = releaseConsumerCases([{ name: f.a }], f.manifests);
  assert.deepEqual([...targeted[0].included], [f.a, f.b]);
  const batch = releaseConsumerCases([{ name: f.b }, { name: f.a }], f.manifests);
  assert.deepEqual(batch.map(c => c.label), ["b", "a", "combined"]);
  assert.deepEqual([...batch[2].included].sort(), [f.a, f.b]);
  assert.throws(() => releaseConsumerLock("fixture", new Set([f.a]), f.manifests, f.artifacts, f.lock), /Missing packed workspace dependency/);
});
