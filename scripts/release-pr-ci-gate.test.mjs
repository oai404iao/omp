import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { checkCiGate, verifyCiRun } from "./release-pr-ci-gate.mjs";

const sha = "a".repeat(40);
const otherSha = "b".repeat(40);

function fixture() {
  const repository = { id: 123, full_name: "oai404iao/omp" };
  const run = {
    id: 456,
    run_attempt: 1,
    repository,
    head_repository: repository,
    event: "push",
    head_branch: "main",
    head_sha: sha,
    status: "completed",
    conclusion: "success",
    workflow_id: 789,
    path: ".github/workflows/ci.yml",
    name: "CI",
  };
  return structuredClone({
    repository: repository.full_name,
    repositoryId: repository.id,
    contextSha: sha,
    event: { action: "completed", repository, workflow_run: run },
    workflow: { id: 789, path: ".github/workflows/ci.yml", name: "CI", state: "active" },
    run,
    latestRun: run,
    mainSha: sha,
  });
}

test("gate accepts only the exact successful canonical main push head", () => {
  const input = fixture();
  assert.equal(verifyCiRun(input), sha);
  input.expectedSha = sha;
  assert.equal(verifyCiRun(input), sha);
});

// Each source is independently validated: a forged webhook cannot stand in for
// the canonical API run, nor can an older success mask a newer failure/rerun.
for (const source of ["event", "run", "latestRun"]) {
  for (const [label, change] of [
    ["failed CI", run => { run.conclusion = "failure"; }],
    ["cancelled CI", run => { run.conclusion = "cancelled"; }],
    ["skipped CI", run => { run.conclusion = "skipped"; }],
    ["in-progress CI", run => { run.status = "in_progress"; }],
    ["PR CI", run => { run.event = "pull_request"; }],
    ["manual CI", run => { run.event = "workflow_dispatch"; }],
    ["wrong branch", run => { run.head_branch = "feature"; }],
    ["fork head", run => { run.head_repository = { id: 444, full_name: "fork/omp" }; }],
    ["missing head repository", run => { delete run.head_repository; }],
    ["wrong repository ID", run => { run.repository = { id: 444, full_name: "oai404iao/omp" }; }],
    ["wrong repository name", run => { run.repository = { id: 123, full_name: "fork/omp" }; }],
    ["wrong workflow ID", run => { run.workflow_id = 888; }],
    ["same-name workflow at another path", run => { run.path = ".github/workflows/fake.yml"; }],
    ["wrong workflow name", run => { run.name = "Other CI"; }],
    ["missing attempt", run => { delete run.run_attempt; }],
    ["mutable head ref", run => { run.head_sha = "main"; }],
  ]) {
    test(`${source}: rejects ${label}`, () => {
      const input = fixture();
      // fixture intentionally shares records; split the source being mutated.
      const run = structuredClone(source === "event" ? input.event.workflow_run : input[source]);
      change(run);
      if (source === "event") input.event.workflow_run = run;
      else input[source] = run;
      assert.throws(() => verifyCiRun(input), /Release PR CI gate:/);
    });
  }
}

for (const [label, change] of [
  ["fork workflow context", input => { input.repository = "fork/omp"; }],
  ["invalid repository ID", input => { input.repositoryId = 0; }],
  ["wrong event repository ID", input => { input.event.repository = { id: 444, full_name: "oai404iao/omp" }; }],
  ["non-completion", input => { input.event.action = "requested"; }],
  ["wrong canonical path", input => { input.workflow.path = ".github/workflows/fake.yml"; }],
  ["disabled canonical workflow", input => { input.workflow.state = "disabled_manually"; }],
  ["main moved", input => { input.mainSha = otherSha; }],
  ["different workflow context SHA", input => { input.contextSha = otherSha; }],
  ["changed verified SHA before write", input => { input.expectedSha = otherSha; }],
  ["superseded event attempt", input => { input.event.workflow_run = { ...input.run, run_attempt: 2 }; }],
  ["superseded CI run", input => { input.latestRun = { ...input.run, id: 999 }; }],
  ["mismatched event run", input => { input.event.workflow_run = { ...input.run, id: 999 }; }],
  ["mismatched event head", input => { input.event.workflow_run = { ...input.run, head_sha: otherSha }; }],
  ["absent API run", input => { delete input.run; }],
  ["absent newest run", input => { delete input.latestRun; }],
]) {
  test(`rejects ${label}`, () => {
    const input = fixture();
    change(input);
    assert.throws(() => verifyCiRun(input), /Release PR CI gate:/);
  });
}

function apiFixture(input) {
  const calls = [];
  const get = async path => {
    calls.push(path);
    if (path.endsWith("/actions/workflows/ci.yml")) return input.workflow;
    if (path.endsWith(`/actions/runs/${input.event.workflow_run.id}`)) return input.run;
    if (path.includes("/actions/workflows/789/runs?")) return { workflow_runs: [input.latestRun] };
    if (path.endsWith("/git/ref/heads/main")) {
      return { ref: "refs/heads/main", object: { type: "commit", sha: input.mainSha } };
    }
    throw new Error(`Unexpected API request: ${path}`);
  };
  return { get, calls };
}

test("fresh API identity lookups precede live-main read, including pre-write revalidation", async () => {
  const input = fixture();
  const api = apiFixture(input);
  assert.equal(await checkCiGate({ ...input, ...api }), sha);
  assert.deepEqual(api.calls, [
    "/repos/oai404iao/omp/actions/workflows/ci.yml",
    "/repos/oai404iao/omp/actions/runs/456",
    `/repos/oai404iao/omp/actions/workflows/789/runs?branch=main&event=push&head_sha=${sha}&per_page=1`,
    "/repos/oai404iao/omp/git/ref/heads/main",
  ]);
  input.mainSha = otherSha;
  await assert.rejects(checkCiGate({ ...input, ...api, expectedSha: sha }), /main moved/);
  assert.equal(api.calls.length, 8);
});

test("API error and missing latest run fail closed", async () => {
  const input = fixture();
  await assert.rejects(checkCiGate({ ...input, get: async () => { throw new Error("API unavailable"); } }), /API unavailable/);
  delete input.latestRun;
  await assert.rejects(checkCiGate({ ...input, ...apiFixture(input) }), /missing run identity/);
});

test("Release PR wiring gates privileged work without rerunning CI or using artifacts", () => {
  const workflow = parse(readFileSync(new URL("../.github/workflows/release-pr.yml", import.meta.url), "utf8"));
  assert.deepEqual(workflow.on, { workflow_run: { workflows: ["CI"], types: ["completed"], branches: ["main"] } });
  assert.deepEqual(workflow.concurrency, { group: "release-pr-main", "cancel-in-progress": false });
  assert.deepEqual(workflow.permissions, { actions: "read", contents: "write", "pull-requests": "write" });
  const job = workflow.jobs["release-pr"];
  for (const condition of ["github.repository == 'oai404iao/omp'", "conclusion == 'success'", "event == 'push'",
    "head_branch == 'main'", "repository.id == github.repository_id", "head_repository.id == github.repository_id"]) {
    assert(job.if.includes(condition), condition);
  }
  const steps = job.steps;
  const checkouts = steps.filter(step => step.uses?.startsWith("actions/checkout@"));
  assert.equal(checkouts.length, 2);
  assert.equal(checkouts[0].with.ref, "${{ github.workflow_sha }}");
  assert.equal(checkouts[1].with.ref, "${{ steps.gate.outputs.sha }}");
  assert.equal(checkouts[1].with["fetch-depth"], 0);
  for (const step of checkouts) assert.equal(step.with["persist-credentials"], false);
  const gate = steps.find(step => step.id === "gate");
  assert(steps.indexOf(checkouts[0]) < steps.indexOf(gate));
  assert(steps.indexOf(gate) < steps.indexOf(checkouts[1]));
  assert.match(gate.run, /cp scripts\/release-pr-ci-gate\.mjs "\$RUNNER_TEMP\/release-pr-ci-gate\.mjs"/);
  assert.match(gate.run, /node "\$RUNNER_TEMP\/release-pr-ci-gate\.mjs"/);
  const install = steps.find(step => step.run === "pnpm install --frozen-lockfile --ignore-scripts");
  assert(install);
  const actionIndex = steps.findIndex(step => step.uses?.startsWith("changesets/action@"));
  const recheck = steps[actionIndex - 1];
  assert.match(recheck.run, /git rev-parse HEAD/);
  assert.match(recheck.run, /node "\$RUNNER_TEMP\/release-pr-ci-gate\.mjs"/);
  assert.equal(recheck.env.VERIFIED_HEAD_SHA, "${{ steps.gate.outputs.sha }}");
  assert(steps.indexOf(install) < steps.indexOf(recheck));
  assert.equal(steps[actionIndex].with["version-script"], "pnpm run changeset:version");
  assert.equal(steps[actionIndex].with["push-with-git-cli"], false);
  for (const step of steps) {
    assert(!step.uses?.includes("artifact"));
    assert(!step.run?.match(/pnpm run ci|ci:pi|test-pi-baselines/));
    assert.equal(step.env?.GITHUB_SHA, undefined);
    assert.equal(step.env?.GITHUB_REF, undefined);
  }
});
