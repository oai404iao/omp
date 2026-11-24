import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { artifactWorkspaces, publishableWorkspaces, readManifest, workspaces } from "./workspaces.mjs";
import { releaseTargets } from "./release-selection.mjs";
import { targetedReleaseWorkspaces } from "./targeted-release.mjs";

test("targeted publication passes the same selection through protected verification and publication", () => {
  const workflow = parse(readFileSync(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8"));
  const input = workflow.on.workflow_dispatch.inputs.package;
  assert.equal(input.type, "string");
  assert.equal(input.required, true);
  assert.equal(input.default, undefined);
  assert.equal(workflow.env.RELEASE_PACKAGE, "${{ inputs.package }}");
  assert.equal(workflow.jobs.publish.environment, "npm-publish");
  assert.equal(workflow.jobs.publish.needs, "verify");
  const steps = workflow.jobs.publish.steps;
  const gate = steps.findIndex(step => step.run?.includes("release-preflight.mjs"));
  const install = steps.findIndex(step => step.run?.split("\n").includes("pnpm install --frozen-lockfile --ignore-scripts"));
  const publish = steps.findIndex(step => step.run?.includes("publish-release-artifacts.mjs"));
  assert.ok(gate >= 0 && gate < install && install < publish, "load locked release tooling after approval and safety gates");
  for (const job of Object.values(workflow.jobs)) {
    assert.equal(job.env?.RELEASE_PACKAGE, undefined);
    for (const step of job.steps) assert.equal(step.env?.RELEASE_PACKAGE, undefined);
  }
});

test("release dispatch selects only explicitly named publishable targets", () => {
  const notify = "@oai404iao/pi-notify";
  const rsi = "@oai404iao/pi-rsi";
  assert.deepEqual(releaseTargets(notify), [notify]);
  assert.deepEqual(releaseTargets(`${rsi}, ${notify}`), [notify, rsi]);
  for (const input of [undefined, "", " ", ",", `${rsi},`, `${rsi},${rsi}`, "*", `${notify},@fixture/unknown`]) {
    assert.throws(() => releaseTargets(input));
  }
  for (const releaseStatus of ["bootstrap", "blocked"]) {
    assert.throws(() => releaseTargets(rsi, [{ name: rsi, releaseStatus }]), /Unapproved/);
  }
});

test("all workspaces satisfy release metadata gates", () => {
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
  assert.throws(() => targetedReleaseWorkspaces("bootstrap", fixture,
    entry => ({ name: entry.name, version: "1.0.0" })), /Unapproved/);
});

test("activated standalone extensions have independent guarded targets, not bootstrap targets", () => {
  assert.equal(workspaces.length, 9);
  assert.equal(publishableWorkspaces.length, 9);
  for (const name of ["@oai404iao/pi-notify", "@oai404iao/pi-rsi"]) {
    const target = workspaces.find(entry => entry.name === name);
    assert.equal(target.releaseStatus, "publishable");
    const manifest = readManifest(target.directory);
    assert.notEqual(manifest.private, true);
    const dependencies = Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies });
    assert.deepEqual(dependencies.filter(dep => workspaces.some(entry => entry.name === dep)), []);
    assert(publishableWorkspaces.includes(target));
    assert(artifactWorkspaces().includes(target));
    assert(artifactWorkspaces(true).includes(target));
    assert.deepEqual(targetedReleaseWorkspaces(name), [target]);
    assert.throws(() => targetedReleaseWorkspaces(name, workspaces, entry => readManifest(entry.directory),
      { bootstrapTarget: true }), /Unapproved/);
  }
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
