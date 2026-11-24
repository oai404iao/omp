import assert from "node:assert/strict";
import { test } from "node:test";
import { codexConsumerMatrix, incompatibleRuntimeLines, sourceConsumerSelection } from "./codex-consumer-matrix.mjs";

test("default and explicit full retain the exhaustive consumer matrix", () => {
  const expected = {
    mode: "full",
    consumers: [
      ["runtime", ["pi-codex-runtime"], [], false],
      ["core", ["pi-codex-core"], [], true],
      ["tools", ["pi-codex-tools"], ["apply_patch", "web_search", "image_generation"], false],
      ["core-tools", ["pi-codex-core", "pi-codex-tools"], ["apply_patch", "web_search", "image_generation"], true],
      ["web", ["pi-codex-web-search"], ["web_search"], false],
      ["image", ["pi-codex-imagegen"], ["image_generation"], false],
      ["core-web", ["pi-codex-core", "pi-codex-web-search"], ["web_search"], true],
      ["core-image", ["pi-codex-core", "pi-codex-imagegen"], ["image_generation"], true],
      ["web-image", ["pi-codex-web-search", "pi-codex-imagegen"], ["web_search", "image_generation"], false],
      ["all", ["pi-codex-core", "pi-codex-tools", "pi-codex-web-search", "pi-codex-imagegen"], ["apply_patch", "web_search", "image_generation"], true],
      ["bundle", ["pi-codex-minimal-tools"], ["apply_patch", "web_search", "image_generation"], true],
      ["duplicate", ["pi-codex-minimal-tools", "pi-codex-core", "pi-codex-web-search", "pi-codex-imagegen"], ["apply_patch", "web_search", "image_generation"], true],
      ["subagent", ["pi-subagent"], [], false],
      ["subagent-no-optional", ["pi-subagent"], [], false],
    ],
    reverseOrders: true,
    capabilityMasks: [0, 1, 2, 3, 4, 5, 6],
    separateRuntimeCopies: true,
  };
  assert.deepEqual(codexConsumerMatrix(), expected);
  assert.deepEqual(codexConsumerMatrix(undefined), expected);
  assert.deepEqual(codexConsumerMatrix("full"), expected);
});

test("smoke loads each package directly once plus a genuine omit-optional subagent", () => {
  const smoke = codexConsumerMatrix("smoke");
  assert.deepEqual(smoke, {
    mode: "smoke",
    consumers: [
      ["runtime", ["pi-codex-runtime"], [], false],
      ["core", ["pi-codex-core"], [], true],
      ["tools", ["pi-codex-tools"], ["apply_patch", "web_search", "image_generation"], false],
      ["web", ["pi-codex-web-search"], ["web_search"], false],
      ["image", ["pi-codex-imagegen"], ["image_generation"], false],
      ["bundle", ["pi-codex-minimal-tools"], ["apply_patch", "web_search", "image_generation"], true],
      ["subagent", ["pi-subagent"], [], false],
      ["subagent-no-optional", ["pi-subagent"], [], false],
    ],
    reverseOrders: false,
    capabilityMasks: [],
    separateRuntimeCopies: false,
  });
  const full = codexConsumerMatrix();
  for (const consumer of smoke.consumers) {
    assert.deepEqual(consumer, full.consumers.find(([label]) => label === consumer[0]));
  }
});

test("unknown modes fail instead of silently reducing coverage", () => {
  for (const mode of ["", "FULL", "Smoke", " smoke", "smoke ", "fast", null, false]) {
    assert.throws(() => codexConsumerMatrix(mode), /Unknown OMP_CODEX_CONSUMER_MODE: .*; expected full or smoke/);
  }
});

test("direct and optional source consumers require a compatible frozen registry resolution when checkout cannot satisfy an edge", () => {
  for (const version of ["4.0.0", "3.2.0-next.1"]) {
    const manifests = new Map([
      ["runtime", { version }], ["tools", { version: "0.2.3", dependencies: { runtime: "^3.1.2" } }],
      ["bundle", { dependencies: { tools: "^0.2.2" } }], ["subagent", { optionalDependencies: { runtime: "^3.1.2" } }],
    ]);
    const ref = { specifier: "^3.1.2", version: "3.3.1(host@1.2.3)" };
    const lock = { importers: { "pi-extensions/tools": { dependencies: { runtime: ref } },
      "pi-extensions/subagent": { optionalDependencies: { runtime: ref } } } };
    const select = (...roots) => sourceConsumerSelection(roots, manifests, lock);
    assert.deepEqual(select("runtime").included, new Set(["runtime"]));
    assert.deepEqual(select("tools").included, new Set(["tools"]));
    for (const [name, owner] of [["bundle", "tools"], ["subagent", "subagent"]]) {
      assert.deepEqual(select(name).resolutions, [{ owner, dependency: "runtime", version: "3.3.1", range: "^3.1.2", sourceVersion: version }]);
    }
    for (const invalid of ["link:../runtime", "file:runtime.tgz", "4.1.0"]) {
      ref.version = invalid;
      assert.throws(() => select("tools"), /No compatible locked registry dependency/);
    }
    manifests.get("runtime").version = "3.2.0";
    assert.deepEqual(select("bundle").included, new Set(["bundle", "tools", "runtime"]));
    assert.deepEqual(select("bundle").resolutions, []);
    manifests.get("tools").dependencies.runtime = "*";
    assert.throws(() => select("tools"), /Unsupported source dependency/);
  }
  assert.equal(incompatibleRuntimeLines(["3.1.2", "3.8.1"]), false);
  assert.equal(incompatibleRuntimeLines(["3.1.2", "4.0.0"]), true);
  assert.equal(incompatibleRuntimeLines(["3.2.0-alpha.1", "3.2.0-alpha.1"]), false);
  assert.equal(incompatibleRuntimeLines(["3.2.0-alpha.1", "3.2.0"]), true);
});
