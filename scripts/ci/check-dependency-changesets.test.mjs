import assert from "node:assert/strict";
import test from "node:test";
import { requireDependencyChangeset } from "./check-dependency-changesets.mjs";

test("only a changed internal dependency contract requires a consumer release", () => {
  const names = new Set(["consumer", "runtime"]);
  const before = { name: "consumer", version: "2.0.0", optionalDependencies: { runtime: "^3.1.2" } };
  const check = (after, releases = [], consumed = []) => requireDependencyChangeset(before, after, names, new Set(releases), consumed);
  const raised = { ...before, optionalDependencies: { runtime: "^3.2.0" } };
  assert.throws(() => check(raised, ["runtime"]), /changeset for this consumer/);
  assert.throws(() => check({ ...before, optionalDependencies: {}, dependencies: before.optionalDependencies }), /consumer/);
  assert.doesNotThrow(() => check(raised, ["consumer"]));
  const consumed = [{ name: "consumer", type: "patch" }];
  assert.throws(() => check({ ...raised, version: "2.0.1" }), /changeset/);
  assert.throws(() => check({ ...raised, version: "2.1.0" }, [], consumed), /changeset/);
  assert.doesNotThrow(() => check({ ...raised, version: "2.0.1" }, [], consumed));
  assert.doesNotThrow(() => check({ ...before, dependencies: { external: "^1.0.0" } }));
});
