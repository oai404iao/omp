import assert from "node:assert/strict";
import test from "node:test";
import { isPiDependency, piDevelopmentVersion, piFloor, piTarget, piVersion } from "./pi-baselines.mjs";
import { preserveRegistryIntegrity } from "./lock-integrity.mjs";

test("explicit floor/target selection never widens the private hook's exact peer", () => {
  assert.equal(piVersion("floor"), "0.84.2");
  assert.equal(piVersion("target"), "0.85.1");
  assert.throws(() => piVersion("latest"), /Unknown Pi baseline/);
  for (const baseline of ["floor", "target"]) {
    assert.equal(piDevelopmentVersion("@oai404iao/pi-tree-continue", baseline), piFloor);
  }
  assert.equal(piDevelopmentVersion("@oai404iao/pi-codex-core", "target"), piTarget);
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
