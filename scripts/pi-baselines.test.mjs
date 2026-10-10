import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseAllDocuments } from "yaml";
import { isPiDependency, piFloor, piFloorArtifacts, piTarget, piVersion } from "./pi-baselines.mjs";
import { preserveRegistryIntegrity } from "./lock-integrity.mjs";
import { readPnpmLock, writePnpmLock } from "./pnpm-lock.mjs";

test("explicit floor/target selection resolves the audited Pi baseline", () => {
  assert.equal(piFloor, piTarget);
  assert.equal(piVersion("floor"), "0.99.1");
  assert.equal(piVersion("target"), "0.99.1");
  assert.throws(() => piVersion("latest"), /Unknown Pi baseline/);
  assert.equal(isPiDependency("@earendil-works/pi-ai"), true);
  assert.equal(isPiDependency("typescript-ast"), false);
});

test("new target package entries reuse only matching hashed artifacts from the new lock", () => {
  const entry = { tarball: "https://registry.npmjs.org/example.tgz" };
  const next = { packages: {
    [`example@${piTarget}`]: { resolution: { ...entry, integrity: "sha512-fixture" } },
    [`alias@${piTarget}`]: { resolution: { ...entry } },
  } };
  assert.equal(preserveRegistryIntegrity({ packages: {} }, next).packages[`alias@${piTarget}`].resolution.integrity, "sha512-fixture");
  assert.throws(() => preserveRegistryIntegrity({ packages: {} }, { packages: {
    [`first@${piTarget}`]: { resolution: { ...entry, integrity: "sha512-first" } },
    [`second@${piTarget}`]: { resolution: { ...entry, integrity: "sha512-second" } },
  } }), /integrity changed/);
});

test("floor-only evidence fills exact artifacts without weakening unknown/mutated hash rejection", () => {
  assert.deepEqual(piFloorArtifacts, []);
  for (const artifact of [{
    version: piFloor, resolved: "https://registry.npmjs.org/floor-fixture.tgz", integrity: "sha512-fixture",
  }]) {
    const { integrity, version, resolved } = artifact;
    const key = `@example/floor@${version}`;
    const lock = { packages: { [key]: { resolution: { tarball: resolved } } } };
    assert.throws(() => preserveRegistryIntegrity({ packages: {} }, structuredClone(lock)), /Missing reviewed/);
    assert.equal(preserveRegistryIntegrity({ packages: {} }, lock, [artifact]).packages[key].resolution.integrity, integrity);
    assert.throws(() => preserveRegistryIntegrity({ packages: {} },
      { packages: { [key]: { resolution: { tarball: resolved, integrity: "sha512-tampered" } } } }, [artifact]), /integrity changed/);
    assert.throws(() => preserveRegistryIntegrity({ packages: {} },
      { packages: { "@example/floor@0.99.2": { resolution: { tarball: resolved } } } }, [artifact]), /Missing reviewed/);
    assert.throws(() => preserveRegistryIntegrity({ packages: {} },
      { packages: { [key]: { resolution: { tarball: `${resolved}?other` } } } }, [artifact]), /Missing reviewed/);
  }
});

test("registry entries require tarball identities while local workspace artifacts are ignored", () => {
  assert.throws(() => preserveRegistryIntegrity({ packages: {} },
    { packages: { "example@1.0.0": { resolution: { integrity: "sha512-fixture" } } } }), /Missing registry artifact tarball/);
  const local = { packages: {
    "local@file:packages/local": { resolution: { directory: "packages/local", type: "directory" } },
  }, importers: { ".": { dependencies: { local: { specifier: "1.0.0", version: "link:packages/local" } } } } };
  assert.equal(preserveRegistryIntegrity({ packages: {} }, local), local);
});

test("conflicting reviewed evidence is rejected before modifying the lock", () => {
  const artifact = { version: piFloor, resolved: "https://registry.npmjs.org/floor-fixture.tgz", integrity: "sha512-fixture" };
  const previous = { packages: {
    [`floor@${piFloor}`]: { resolution: { tarball: artifact.resolved, integrity: artifact.integrity } },
  } };
  assert.throws(() => preserveRegistryIntegrity(previous, { packages: {} },
    [{ ...artifact, integrity: "sha512-conflict" }]), /Conflicting locked artifact integrity/);
});

test("pnpm lockfile updates preserve the tooling document and read application dependencies", () => {
  const cwd = mkdtempSync(join(tmpdir(), "omp-pnpm-lock-"));
  try {
    const path = join(cwd, "pnpm-lock.yaml");
    writeFileSync(path, "---\nlockfileVersion: '9.0'\npackages:\n  pnpm@12.4.1:\n    resolution:\n      integrity: sha512-tooling\n---\nlockfileVersion: '9.0'\nsettings: {}\nimporters: {}\npackages: {}\n");
    const tooling = parseAllDocuments(readFileSync(path, "utf8"))[0].toJS();
    const lock = readPnpmLock(path);
    assert.deepEqual(lock.packages, {});
    lock.packages["example@1.0.0"] = { resolution: { tarball: "https://registry.npmjs.org/example.tgz", integrity: "sha512-fixture" } };
    writePnpmLock(path, lock);
    const documents = parseAllDocuments(readFileSync(path, "utf8"));
    assert.equal(documents.length, 2);
    assert.deepEqual(documents[0].toJS(), tooling);
    assert.deepEqual(readPnpmLock(path), lock);
    const single = join(cwd, "single.yaml");
    writePnpmLock(single, lock);
    assert.deepEqual(readPnpmLock(single), lock);
    lock.importers["."] = { dependencies: {} };
    writePnpmLock(single, lock);
    assert.deepEqual(readPnpmLock(single), lock);
    writeFileSync(path, "---\npackages: {}\n---\npackages: {}\n");
    assert.throws(() => readPnpmLock(path), /Expected one application/);
    writeFileSync(path, "settings: {}\nsettings: {}\n");
    assert.throws(() => readPnpmLock(path), /Map keys must be unique/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
