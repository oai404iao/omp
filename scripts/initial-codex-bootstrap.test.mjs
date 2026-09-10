import assert from "node:assert/strict";
import test from "node:test";
import { hasInitialBootstrapLatestAlias, isInitialCodexBootstrap } from "./initial-codex-bootstrap.mjs";

const candidate = {
  name: "@oai404iao/pi-codex-runtime", version: "0.1.0-alpha.1",
  sourceCommit: "32ba01f3c08b7fd63d09e9b2373cf081c4525533",
  prerelease: true, distTag: "next",
};
const tags = { next: candidate.version, latest: candidate.version };
for (const short of ["runtime", "core", "imagegen", "web-search"]) {
  test(`initial ${short} accepts only its reviewed sole-version latest/next alias`, () => {
    const value = { ...candidate, name: `@oai404iao/pi-codex-${short}` };
    assert.equal(hasInitialBootstrapLatestAlias(value, tags, [value.version]), true);
  });
}
test("bootstrap alias is not a general prerelease/latest exemption", () => {
  for (const override of [
    { name: "@oai404iao/pi-codex-minimal-tools" }, { name: "@oai404iao/pi-subagent" },
    { name: "@oai404iao/unknown" }, { version: "0.1.0-alpha.2" }, { version: "0.1.0" },
    { sourceCommit: "0".repeat(40) }, { sourceCommit: undefined }, { prerelease: false },
    { distTag: "latest" },
  ]) assert.equal(isInitialCodexBootstrap({ ...candidate, ...override }), false);
  for (const versions of [undefined, null, "0.1.0-alpha.1", {}, [], ["0.0.1", candidate.version],
    ["0.1.0-alpha.0", candidate.version], [candidate.version, candidate.version], ["invalid"]]) {
    assert.equal(hasInitialBootstrapLatestAlias(candidate, tags, versions), false);
  }
  for (const value of [undefined, {}, { latest: candidate.version },
    { next: candidate.version, latest: "0.1.0" }, { ...tags, next: "0.1.0-alpha.0" }]) {
    assert.equal(hasInitialBootstrapLatestAlias(candidate, value, [candidate.version]), false);
  }
});
