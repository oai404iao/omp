import assert from "node:assert/strict";
import test from "node:test";
import { isPiDependency, piFloor, piFloorArtifacts, piTarget, piVersion } from "./pi-baselines.mjs";
import { preserveRegistryIntegrity } from "./lock-integrity.mjs";

test("explicit floor/target selection resolves the audited Pi baseline", () => {
  assert.notEqual(piFloor, piTarget);
  assert.equal(piVersion("floor"), "0.87.0");
  assert.equal(piVersion("target"), "0.87.1");
  assert.throws(() => piVersion("latest"), /Unknown Pi baseline/);
  assert.equal(isPiDependency("@earendil-works/pi-ai"), true);
  assert.equal(isPiDependency("typescript-ast"), false);
});

test("new target shrinkwrap entries reuse only matching hashed artifacts from the new lock", () => {
  const entry = { version: piTarget, resolved: "https://registry.npmjs.org/example.tgz" };
  const next = { packages: { hoisted: { ...entry, integrity: "sha512-fixture" }, nested: { ...entry } } };
  assert.equal(preserveRegistryIntegrity({ packages: {} }, next).packages.nested.integrity, "sha512-fixture");
  assert.throws(() => preserveRegistryIntegrity({ packages: {} }, { packages: {
    first: { ...entry, integrity: "sha512-first" }, second: { ...entry, integrity: "sha512-second" },
  } }), /integrity changed/);
});

test("floor-only evidence fills exact artifacts without weakening unknown/mutated hash rejection", () => {
  for (const artifact of piFloorArtifacts) {
    assert.equal(artifact.version, piFloor);
    const { integrity, ...unhashed } = artifact;
    const lock = { packages: { nested: { ...unhashed } } };
    assert.throws(() => preserveRegistryIntegrity({ packages: {} }, structuredClone(lock)), /Missing reviewed/);
    assert.equal(preserveRegistryIntegrity({ packages: {} }, lock, piFloorArtifacts).packages.nested.integrity, integrity);
    assert.throws(() => preserveRegistryIntegrity({ packages: {} },
      { packages: { nested: { ...artifact, integrity: "sha512-tampered" } } }, piFloorArtifacts), /integrity changed/);
    assert.throws(() => preserveRegistryIntegrity({ packages: {} },
      { packages: { nested: { ...unhashed, version: "0.87.2" } } }, piFloorArtifacts), /Missing reviewed/);
  }
});
