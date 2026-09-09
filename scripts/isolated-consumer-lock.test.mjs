import assert from "node:assert/strict";
import test from "node:test";
import { isolatedConsumerLock } from "./isolated-consumer-lock.mjs";
import { preserveRegistryIntegrity } from "./lock-integrity.mjs";

const entry = (version, name = "lib") => ({
  version, resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
  integrity: "sha512-fixture", dev: true,
});
test("consumer lock projects only production/peer closure and relocates nested workspace dependencies", () => {
  const name = "@oai404iao/pi-codex-core";
  const manifests = new Map([[name, { version: "0.1.0", dependencies: { lib: "2" }, peerDependencies: { host: "1" } }]]);
  const artifacts = new Map([[name, { path: "/tmp/core.tgz", integrity: "sha512-core" }]]);
  const source = { packages: {
    "node_modules/lib": entry("1"),
    "node_modules/dev-only": entry("9"),
    "node_modules/host": { ...entry("1", "host"), dependencies: { lib: "1" } },
    "pi-extensions/pi-codex-core/node_modules/lib": entry("2"),
  } };
  const { lock } = isolatedConsumerLock("fixture", [name], manifests, artifacts, source);
  assert.ok(!lock.packages["node_modules/dev-only"]);
  assert.equal(lock.packages["node_modules/lib"].version, "1");
  assert.equal(lock.packages[`node_modules/${name}/node_modules/lib`].version, "2");
  assert.equal(lock.packages["node_modules/host"].dev, undefined);
  assert.equal(lock.packages[`node_modules/${name}`].integrity, "sha512-core");
  source.packages["node_modules/host"].link = true;
  assert.throws(() => isolatedConsumerLock("fixture", [name], manifests, artifacts, source), /linked external/);
});

test("lost shrinkwrap hashes can only be restored from the same locked URL and version", () => {
  const previous = { packages: { a: entry("1") } };
  const next = { packages: { a: { ...entry("1"), integrity: undefined } } };
  assert.equal(preserveRegistryIntegrity(previous, next).packages.a.integrity, "sha512-fixture");
  assert.throws(() => preserveRegistryIntegrity(previous, { packages: { a: { ...entry("1"), integrity: "sha512-other" } } }), /integrity changed/);
  assert.throws(() => preserveRegistryIntegrity(previous, { packages: { a: { ...entry("2"), integrity: undefined } } }), /Missing reviewed/);
});
