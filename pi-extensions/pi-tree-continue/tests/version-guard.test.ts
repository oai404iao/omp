import assert from "node:assert/strict";
import test from "node:test";
import { TESTED_PI_VERSION, supportsTestedPiVersion } from "../src/index.js";

test("only enables the private hook for its exact audited Pi version", () => {
	assert.equal(TESTED_PI_VERSION, "0.84.2");
	assert.equal(supportsTestedPiVersion(), true);
	assert.equal(supportsTestedPiVersion("0.84.2"), true);
	assert.equal(supportsTestedPiVersion("0.84.3"), false);
	assert.equal(supportsTestedPiVersion("0.85.0"), false);
	assert.equal(supportsTestedPiVersion("0.84.2-beta.1"), false);
});
