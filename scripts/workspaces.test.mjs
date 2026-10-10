import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { artifactWorkspaces, publishableWorkspaces, readManifest, workspaces } from "./workspaces.mjs";

for (const [directory, name] of [
  ["external-thinking", "pi-external-thinking"],
  ["pi-keep-defaults", "pi-keep-defaults"],
  ["pi-tree-continue", "pi-tree-continue"],
  ["pi-code-mode", "pi-code-mode"],
]) {
  test(`removed ${name} is absent from workspaces and every artifact selection`, () => {
    const workspace = parse(readFileSync(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8"));
    assert(!workspace.packages.includes(`pi-extensions/${directory}`));
    for (const entries of [workspaces, publishableWorkspaces, artifactWorkspaces(), artifactWorkspaces(true)]) {
      assert(!entries.some(entry => entry.name === `@oai404iao/${name}`));
    }
  });
}

test("all workspaces, including private packages, satisfy release metadata gates", () => {
  for (const { name, directory } of workspaces) {
    const manifest = readManifest(directory);
    assert.deepEqual(manifest.repository, {
      type: "git",
      url: "git+https://github.com/oai404iao/omp.git",
      directory,
    }, name);
    assert.equal(manifest.homepage, `https://github.com/oai404iao/omp/tree/main/${directory}#readme`, name);
    assert.equal(manifest.bugs?.url, "https://github.com/oai404iao/omp/issues", name);
  }
});

test("bootstrap packages stay out of guarded release artifacts", () => {
  const fixture = [
    { name: "publishable", releaseStatus: "publishable" },
    { name: "bootstrap", releaseStatus: "bootstrap" },
    { name: "blocked", releaseStatus: "blocked" },
  ];
  assert.deepEqual(
    artifactWorkspaces(false, fixture).map(({ name }) => name),
    ["publishable"],
  );
  assert.deepEqual(
    artifactWorkspaces(true, fixture).map(({ name }) => name),
    ["publishable", "bootstrap"],
  );
});

test("subagent enters guarded artifacts after bootstrap activation", () => {
  const subagent = workspaces.find(({ name }) => name === "@oai404iao/pi-subagent");
  assert.equal(subagent?.releaseStatus, "publishable");

  const guardedNames = artifactWorkspaces().map(({ name }) => name);
  assert.deepEqual(
    guardedNames,
    publishableWorkspaces.map(({ name }) => name),
  );
  assert(guardedNames.includes("@oai404iao/pi-subagent"));
});

test("Codex minimal tools enters guarded artifacts after bootstrap activation", () => {
  const codex = workspaces.find(({ name }) => name === "@oai404iao/pi-codex-minimal-tools");
  assert.equal(codex?.releaseStatus, "publishable");
  assert(publishableWorkspaces.some(({ name }) => name === "@oai404iao/pi-codex-minimal-tools"));
  assert(artifactWorkspaces().some(({ name }) => name === "@oai404iao/pi-codex-minimal-tools"));
  assert(artifactWorkspaces(true).some(({ name }) => name === "@oai404iao/pi-codex-minimal-tools"));
});
