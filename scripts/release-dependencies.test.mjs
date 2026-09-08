import assert from "node:assert/strict";
import test from "node:test";
import { assertReleaseDependencies, orderReleaseWorkspaces } from "./release-dependencies.mjs";
import { workspaces } from "./workspaces.mjs";

test("publishable bundles fail closed on direct and transitive blocked dependencies", () => {
  const entries = ["bundle", "core", "runtime"].map(name => ({
    name, releaseStatus: name === "runtime" ? "blocked" : "publishable",
  }));
  const manifests = {
    bundle: { version: "1.0.0", dependencies: { core: "1.0.0" } },
    core: { version: "1.0.0", optionalDependencies: { runtime: "1.0.0" } },
    runtime: { version: "1.0.0", private: true },
  };
  assert.throws(() => assertReleaseDependencies(entries.slice(0, 2), entries, e => manifests[e.name]),
    /bundle -> core -> runtime/);
});

test("bootstrap batches require included dependencies and exact pins", () => {
  const entries = [{ name: "bundle", releaseStatus: "publishable" }, { name: "core", releaseStatus: "bootstrap" }];
  const manifests = {
    bundle: { version: "1.0.0", dependencies: { core: "1.0.0" } },
    core: { version: "1.0.0" },
  };
  assert.throws(() => assertReleaseDependencies([entries[0]], entries, e => manifests[e.name]), /outside/);
  assert.doesNotThrow(() => assertReleaseDependencies(entries, entries, e => manifests[e.name]));
  manifests.bundle.dependencies.core = "^1.0.0";
  assert.throws(() => assertReleaseDependencies(entries, entries, e => manifests[e.name]), /exactly pinned/);
});

test("the S3 compatibility bundle cannot enter release artifacts before new packages are approved", () => {
  const bundle = workspaces.find(e => e.name === "@oai404iao/pi-codex-minimal-tools");
  assert.throws(() => assertReleaseDependencies([bundle]), /Release blocked.*pi-codex-runtime/);
});

test("artifact order includes recovery/optional dependencies and is independent of input order", () => {
  const selected = ["bundle", "image", "core", "runtime"].map(name => ({ name }));
  const manifests = {
    bundle: { dependencies: { image: "1", core: "1" } },
    image: { optionalDependencies: { runtime: "1" } },
    core: { dependencies: { runtime: "1" } }, runtime: {},
  };
  const order = entries => orderReleaseWorkspaces(entries, entry => manifests[entry.name]).map(e => e.name);
  assert.deepEqual(order(selected), ["runtime", "core", "image", "bundle"]);
  assert.deepEqual(order([...selected].reverse()), order(selected));
  assert.throws(() => order([...selected, selected[0]]), /Duplicate/);
  manifests.runtime.dependencies = { bundle: "1" };
  assert.throws(() => order(selected), /cycle/);
});
