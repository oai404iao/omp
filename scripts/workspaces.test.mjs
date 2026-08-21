import assert from "node:assert/strict";
import test from "node:test";
import { artifactWorkspaces, publishableWorkspaces, workspaces } from "./workspaces.mjs";

test("bootstrap packages stay out of guarded release artifacts", () => {
  const subagent = workspaces.find(({ name }) => name === "@oai404iao/pi-subagent");
  assert.equal(subagent?.releaseStatus, "bootstrap");

  const guardedNames = artifactWorkspaces().map(({ name }) => name);
  const bootstrapNames = artifactWorkspaces(true).map(({ name }) => name);
  assert.deepEqual(
    guardedNames,
    publishableWorkspaces.map(({ name }) => name),
  );
  assert(!guardedNames.includes("@oai404iao/pi-subagent"));
  assert(bootstrapNames.includes("@oai404iao/pi-subagent"));
});
