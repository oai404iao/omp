import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { expectedJobNames } from "./ci/trusted-main.mjs";
import { root } from "./workspaces.mjs";

const workflows = readdirSync(join(root, ".github/workflows"))
  .filter(path => /\.ya?ml$/.test(path))
  .map(path => [path, parse(readFileSync(join(root, ".github/workflows", path), "utf8"))]);
const workflow = workflows.find(([path]) => path === "ci.yml")[1];
const publish = workflows.find(([path]) => path === "publish.yml")[1];
const setup = parse(readFileSync(join(root, ".github/actions/setup-ci/action.yml"), "utf8"));

test("workflows never run privileged pull_request_target code or persist checkout credentials", () => {
  for (const [path, workflow] of workflows) {
    const events = typeof workflow.on === "string" ? [workflow.on]
      : Array.isArray(workflow.on) ? workflow.on : Object.keys(workflow.on);
    assert.ok(!events.includes("pull_request_target"), path);
    for (const job of Object.values(workflow.jobs)) for (const step of job.steps ?? []) {
      if (step.uses?.startsWith("actions/checkout@")) {
        assert.equal(step.with?.["persist-credentials"], false, path);
      }
      if (step.uses && !step.uses.startsWith("./")) {
        assert.match(step.uses, /@[a-f0-9]{40}$/, path);
      }
    }
  }
});

test("PR verification has only read permissions and no publishing environment", () => {
  assert.deepEqual(workflow.permissions, { contents: "read" });
  for (const [id, job] of Object.entries(workflow.jobs)) {
    for (const permission of Object.values(job.permissions ?? {})) {
      assert.ok(["read", "none"].includes(permission), id);
    }
    assert.equal(job.environment, undefined, id);
  }
});

test("the required check always aggregates the planned coverage graph", () => {
  const { verify, "trusted-main-coverage": coverage } = workflow.jobs;
  assert.equal(verify.name, "Verification / Required");
  assert.ok(expectedJobNames.includes(verify.name));
  assert.equal(verify.if, "always()");
  assert.equal(verify.strategy, undefined);
  assert.deepEqual(verify.needs, ["plan", "policy", "packages", "suites"]);
  assert.deepEqual(coverage.needs, [...verify.needs, "verify"]);
});

test("every CI job uses Node.js 24 directly or through the shared setup action", () => {
  const nodeVersion = steps => steps.find(step => step.uses?.startsWith("actions/setup-node@"))?.with?.["node-version"];
  assert.equal(nodeVersion(setup.runs.steps), "24.x");
  for (const [id, job] of Object.entries(workflow.jobs)) {
    if (!job.steps.some(step => step.uses === "./.github/actions/setup-ci")) {
      assert.equal(nodeVersion(job.steps), "24.x", id);
    } else {
      assert.equal(nodeVersion(job.steps), undefined, `${id} must not override the shared setup`);
    }
  }
});

test("publishing requires successful verification and the protected npm environment", () => {
  assert.deepEqual(publish.permissions, { contents: "read" });
  assert.deepEqual(publish.jobs.verify.permissions, { contents: "read", actions: "read" });
  const publication = publish.jobs.publish;
  const needs = Array.isArray(publication.needs) ? publication.needs : [publication.needs];
  assert.ok(needs.includes("verify"));
  assert.equal(publication.if, undefined, "use the default success gate, not an unconditional publication");
  assert.equal(publication["continue-on-error"], undefined);
  assert.equal(publish.jobs.verify["continue-on-error"], undefined);
  assert.equal(typeof publication.environment === "string" ? publication.environment : publication.environment?.name,
    "npm-publish");
  assert.deepEqual(publication.permissions, { contents: "write", "id-token": "write" });
  assert.equal(publish.concurrency["cancel-in-progress"], false);
});
