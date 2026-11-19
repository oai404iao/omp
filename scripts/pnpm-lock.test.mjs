import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseAllDocuments } from "yaml";
import { preserveRegistryIntegrity } from "./lock-integrity.mjs";
import { readPnpmLock, writePnpmLock } from "./pnpm-lock.mjs";

test("new package entries reuse only matching hashed artifacts from the new lock", () => {
  const entry = { tarball: "https://registry.npmjs.org/example.tgz" };
  const next = { packages: {
    "example@2.0.0": { resolution: { ...entry, integrity: "sha512-fixture" } },
    "alias@2.0.0": { resolution: { ...entry } },
  } };
  assert.equal(preserveRegistryIntegrity({ packages: {} }, next).packages["alias@2.0.0"].resolution.integrity, "sha512-fixture");
  assert.throws(() => preserveRegistryIntegrity({ packages: {} }, { packages: {
    "first@2.0.0": { resolution: { ...entry, integrity: "sha512-first" } },
    "second@2.0.0": { resolution: { ...entry, integrity: "sha512-second" } },
  } }), /integrity changed/);
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
  const tarball = "https://registry.npmjs.org/example.tgz";
  const previous = { packages: {
    "example@2.0.0": { resolution: { tarball, integrity: "sha512-fixture" } },
    "alias@2.0.0": { resolution: { tarball, integrity: "sha512-conflict" } },
  } };
  assert.throws(() => preserveRegistryIntegrity(previous, { packages: {} }), /Conflicting locked artifact integrity/);
});

test("an artifact at a different URL cannot reuse an integrity hash from the same version", () => {
  const previous = { packages: {
    "example@2.0.0": { resolution: { tarball: "https://registry.npmjs.org/example.tgz", integrity: "sha512-fixture" } },
  } };
  const next = { packages: {
    "example@2.0.0": { resolution: { tarball: "https://registry.npmjs.org/replacement.tgz" } },
  } };
  assert.throws(() => preserveRegistryIntegrity(previous, next), /Missing reviewed artifact integrity/);
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
