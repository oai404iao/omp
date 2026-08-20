import assert from "node:assert/strict";
import test from "node:test";
import { tarballFacingChangedPaths } from "./recovery-guard.mjs";

test("a packed source file removed by a rename blocks recovery", () => {
  const changedPaths = [
    "pi-extensions/example/src/entry.ts",
    "pi-extensions/example/test/entry.ts",
  ];
  const currentPackedPaths = new Set();

  assert.deepEqual(
    tarballFacingChangedPaths(changedPaths, "pi-extensions/example", currentPackedPaths),
    ["src/entry.ts"],
  );
});

test("test-only and TypeScript-config changes do not block recovery", () => {
  const changedPaths = [
    "pi-extensions/example/test/entry.test.mjs",
    "pi-extensions/example/tests/smoke.test.ts",
    "pi-extensions/example/reference/example.md",
    "pi-extensions/example/tsconfig.json",
  ];

  assert.deepEqual(
    tarballFacingChangedPaths(changedPaths, "pi-extensions/example", new Set()),
    [],
  );
});
