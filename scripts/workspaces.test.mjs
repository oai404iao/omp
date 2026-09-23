import assert from "node:assert/strict";
import test from "node:test";
import { artifactWorkspaces, publishableWorkspaces, readManifest, workspaces } from "./workspaces.mjs";

test("retired keep-defaults is absent from workspaces and every artifact selection", () => {
  assert(!readManifest(".").workspaces.includes("pi-extensions/pi-keep-defaults"));
  for (const entries of [workspaces, publishableWorkspaces, artifactWorkspaces(), artifactWorkspaces(true)]) {
    assert(!entries.some(({ name }) => name === "@oai404iao/pi-keep-defaults"));
  }
});

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

test("Code Mode S1 is installable locally but excluded from publication", () => {
  assert.equal(workspaces.find(({ name }) => name === "@oai404iao/pi-code-mode")?.releaseStatus, "blocked");
  assert(!artifactWorkspaces(true).some(({ name }) => name === "@oai404iao/pi-code-mode"));
});
