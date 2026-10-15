import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { artifactWorkspaces, publishableWorkspaces, readManifest, workspaces } from "./workspaces.mjs";
import { targetedReleaseWorkspaces } from "./targeted-release.mjs";

test("targeted publication passes the same selection through protected verification and publication", () => {
  const workflow = parse(readFileSync(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8"));
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.package, {
    description: "Optional exact workspace package name; blank publishes the full batch",
    required: false,
    default: "",
    type: "string",
  });
  assert.equal(workflow.env.RELEASE_PACKAGE, "${{ inputs.package }}");
  assert.equal(workflow.jobs.publish.environment, "npm-publish");
  assert.equal(workflow.jobs.publish.needs, "verify");
  for (const job of Object.values(workflow.jobs)) {
    assert.equal(job.env?.RELEASE_PACKAGE, undefined);
    for (const step of job.steps) assert.equal(step.env?.RELEASE_PACKAGE, undefined);
  }
});

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

test("verified Codex tools enters guarded artifacts and targeted publication after activation", () => {
  const tools = workspaces.find(({ name }) => name === "@oai404iao/pi-codex-tools");
  assert.equal(tools?.releaseStatus, "publishable");
  const manifest = readManifest(tools.directory);
  assert.equal(manifest.private, false);
  assert.equal(manifest.version, "0.1.0-alpha.1");
  for (const entries of [publishableWorkspaces, artifactWorkspaces()]) {
    assert(entries.some(({ name }) => name === tools.name));
  }
  assert(artifactWorkspaces(true).some(({ name }) => name === tools.name));
  assert.deepEqual(targetedReleaseWorkspaces(tools.name).map(entry => entry.name), [
    "@oai404iao/pi-codex-runtime", tools.name,
  ]);
  assert.throws(() => targetedReleaseWorkspaces(tools.name, workspaces, entry => readManifest(entry.directory),
    { bootstrapTarget: true }), /Unapproved/);
  for (const name of ["runtime", "core", "web-search", "imagegen"]) {
    assert.equal(workspaces.find(entry => entry.name === `@oai404iao/pi-codex-${name}`)?.releaseStatus, "publishable");
  }
});
