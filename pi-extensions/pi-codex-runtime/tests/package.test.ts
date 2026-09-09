import assert from "node:assert/strict";
import test from "node:test";
import * as entry from "../src/index.js";
test("library exposes services, not an auto-registering extension factory", () => {
	assert.equal(typeof entry.getCodexBroker, "function");
	assert.equal("default" in entry, false);
});
