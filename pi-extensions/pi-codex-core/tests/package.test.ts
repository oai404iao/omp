import assert from "node:assert/strict";
import test from "node:test";
import entry from "../src/index.js";
test("package entry is importable", () => assert.equal(typeof entry, "function"));
