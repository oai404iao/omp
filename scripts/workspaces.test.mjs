import assert from "node:assert/strict";
import test from "node:test";
import { artifactWorkspaces, publishableWorkspaces, workspaces } from "./workspaces.mjs";

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

test("Codex minimal tools stays blocked while its separate public gate is pending", () => {
  const codex = workspaces.find(({ name }) => name === "@oai404iao/pi-codex-minimal-tools");
  assert.equal(codex?.releaseStatus, "blocked");
  assert(!publishableWorkspaces.some(({ name }) => name === "@oai404iao/pi-codex-minimal-tools"));
  assert(!artifactWorkspaces().some(({ name }) => name === "@oai404iao/pi-codex-minimal-tools"));
});
