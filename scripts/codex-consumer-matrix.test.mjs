import assert from "node:assert/strict";
import { test } from "node:test";
import { codexConsumerMatrix } from "./codex-consumer-matrix.mjs";

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
    ],
    reverseOrders: true,
    capabilityMasks: [0, 1, 2, 3, 4, 5, 6],
    separateRuntimeCopies: true,
  };
  assert.deepEqual(codexConsumerMatrix(), expected);
  assert.deepEqual(codexConsumerMatrix(undefined), expected);
  assert.deepEqual(codexConsumerMatrix("full"), expected);
});

test("smoke selects the bundle with core and all tools without exhaustive sweeps", () => {
  const smoke = codexConsumerMatrix("smoke");
  assert.deepEqual(smoke, {
    mode: "smoke",
    consumers: [["bundle", ["pi-codex-minimal-tools"], ["apply_patch", "web_search", "image_generation"], true]],
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
