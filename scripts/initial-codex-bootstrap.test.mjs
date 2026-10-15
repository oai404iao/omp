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

test("tools initial alias is bound to its reviewed source and exact staged-placeholder history", () => {
  const tools = { ...candidate, name: "@oai404iao/pi-codex-tools",
    sourceCommit: "b9deaba6ba07d87c048e474b2ddc977f3bd2b442" };
  const history = ["0.0.0-stage", tools.version];
  assert.equal(hasInitialBootstrapLatestAlias(tools, tags, history), true);
  assert.equal(hasInitialBootstrapLatestAlias(tools, tags, [...history].reverse()), true);
  assert.equal(hasInitialBootstrapLatestAlias(candidate, tags, history), false);
  for (const override of [
    { sourceCommit: candidate.sourceCommit }, { sourceCommit: "0".repeat(40) },
    { name: candidate.name }, { name: "@oai404iao/pi-codex-imagegen" },
    { name: "@oai404iao/pi-codex-minimal-tools" }, { version: "0.1.0-alpha.2" },
    { version: "0.1.0" }, { prerelease: false }, { distTag: "latest" },
  ]) assert.equal(isInitialCodexBootstrap({ ...tools, ...override }), false);
  for (const versions of [undefined, {}, [], [tools.version], ["0.0.0-stage"],
    [tools.version, "0.1.0-alpha.2"], ["0.0.1", tools.version],
    [tools.version, tools.version], ["0.0.0-stage", tools.version, "0.1.0-alpha.2"]]) {
    assert.equal(hasInitialBootstrapLatestAlias(tools, tags, versions), false);
  }
  for (const value of [undefined, {}, { latest: tools.version },
    { next: "0.1.0-alpha.0", latest: tools.version }, { next: tools.version, latest: "0.1.0" }]) {
    assert.equal(hasInitialBootstrapLatestAlias(tools, value, history), false);
  }
});
