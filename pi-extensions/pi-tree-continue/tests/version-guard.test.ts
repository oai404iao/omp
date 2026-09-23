import assert from "node:assert/strict";
import { test } from "node:test";
import { supportsTestedPiVersion, TESTED_PI_VERSIONS } from "../src/index.js";

test("only enables the private hook for its exact audited Pi versions", () => {
	assert.deepEqual(TESTED_PI_VERSIONS, ["0.87.0", "0.87.1"]);
	assert(supportsTestedPiVersion());
	for (const version of TESTED_PI_VERSIONS) assert(supportsTestedPiVersion(version));
	for (const version of ["0.86.1", "0.87.2", "0.88.0", "0.87.1-beta.1", "unknown"]) {
		assert.equal(supportsTestedPiVersion(version), false);
	}
});
