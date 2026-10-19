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

test("verified Codex tools enters guarded artifacts and targeted publication after activation", () => {
  const tools = workspaces.find(({ name }) => name === "@oai404iao/pi-codex-tools");
  assert.equal(tools?.releaseStatus, "publishable");
  const manifest = readManifest(tools.directory);
  assert.equal(manifest.private, false);
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
