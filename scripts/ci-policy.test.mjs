import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { root } from "./workspaces.mjs";
import { policyScripts, suites, testPackages } from "./ci/catalog.mjs";

const read = path => parse(readFileSync(join(root, path), "utf8"));
const workflow = read(".github/workflows/ci.yml");
const publish = read(".github/workflows/publish.yml");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

test("CI always plans PR changes and full main/manual coverage without workflow path skips", () => {
  assert.deepEqual(workflow.on, { pull_request: null, push: { branches: ["main"] }, workflow_dispatch: null });
  assert.deepEqual(workflow.permissions, { contents: "read" });
  const plan = workflow.jobs.plan;
  assert.equal(plan.name, "Verification plan");
  assert.equal(plan.steps[0].with["fetch-depth"], 0);
  const selection = plan.steps.find(step => step.id === "plan");
  assert.equal(selection.env.BASE_SHA, "${{ github.event.pull_request.base.sha }}");
  assert.match(selection.run, /--base "\$BASE_SHA" --head "\$GITHUB_SHA"/);
  assert.match(selection.run, /--full --head "\$GITHUB_SHA"/);
  for (const field of ["plan", "packages", "suites", "has_packages", "has_suites", "full"]) {
    assert.equal(plan.outputs[field], `\${{ steps.plan.outputs.${field} }}`);
  }
});

test("package and suite matrices are bounded and gated by fresh policy", () => {
  for (const [id, field, maximum] of [["packages", "package", 4], ["suites", "suite", 3]]) {
    const job = workflow.jobs[id];
    assert.deepEqual(job.needs, ["plan", "policy"]);
    assert.equal(job.if, `needs.plan.outputs.has_${id} == 'true'`);
    assert.equal(job.strategy["fail-fast"], false);
    assert.equal(job.strategy["max-parallel"], maximum);
    assert.equal(job.strategy.matrix[field], `\${{ fromJSON(needs.plan.outputs.${id}) }}`);
    assert.ok(job.steps.some(step => step.uses === "./.github/actions/setup-ci"));
    const run = job.steps.find(step => step.run?.includes("--task"));
    assert.match(run.run, /--plan .*--task .*--report/);
    assert.match(run.run, /git diff --exit-code/);
  }
  assert.equal(workflow.jobs.suites.steps.find(step => step.env?.OMP_CODEX_CONSUMER_MODE)
    .env.OMP_CODEX_CONSUMER_MODE, "full");
  assert.equal(testPackages.length, 9);
  assert.deepEqual(suites, ["composition", "consumers", "infrastructure"]);
});

test("the canonical target is distributed once; remaining compatibility roles retain guarded reuse", () => {
  const compatibility = workflow.jobs.compatibility;
  assert.equal(compatibility.if, "github.event_name != 'pull_request'");
  assert.deepEqual(compatibility.strategy.matrix.include, [
    { node: "22.19.0", pi: "floor" }, { node: "22.19.0", pi: "target" }, { node: "24.x", pi: "floor" },
  ]);
  const baseline = compatibility.steps.find(step => step.run?.startsWith("node scripts/test-pi-baselines"));
  assert.equal(baseline.env.OMP_PI_REUSE_TARGET, "1");
  assert.equal(baseline.env.OMP_CODEX_CONSUMER_MODE, "smoke");
  assert.ok(policyScripts.includes("check:pi-baseline"));
  assert.equal(workflow.env.PI_OFFLINE, "1");
  assert.equal(workflow.env.PI_TELEMETRY, "0");
});

test("all legacy required contexts aggregate failures, skips and cancelled matrices", () => {
  const verify = workflow.jobs.verify;
  assert.equal(verify.name, "Node ${{ matrix.node }} / Pi ${{ matrix.pi }}");
  assert.equal(verify.if, "always()");
  assert.deepEqual(verify.needs, ["plan", "policy", "packages", "suites", "compatibility"]);
  assert.deepEqual(verify.strategy.matrix, { node: ["22.19.0", "24.x"], pi: ["floor", "target"] });
  const gate = verify.steps.at(-1);
  assert.equal(gate.run, "node scripts/ci/aggregate.mjs");
  assert.equal(gate.env.CI_NEEDS, "${{ toJSON(needs) }}");
  const trusted = workflow.jobs["trusted-main-coverage"];
  assert.equal(trusted.name, "Trusted main coverage / v1");
  assert.deepEqual(trusted.needs, [...verify.needs, "verify"]);
  assert.match(trusted.if, /always\(\).*github.event_name == 'push'.*refs\/heads\/main/);
  assert.equal(trusted.steps.at(-1).env.REQUIRE_FULL_COVERAGE, "1");
});

test("full local CI retains every task and policy is a barrier before expensive tests", () => {
  assert.equal(manifest.scripts.ci, "node scripts/ci/run.mjs --full");
  assert.deepEqual(policyScripts, ["changeset:check", "pack:check", "license:check",
    "check:architecture", "test:architecture", "check:pi-baseline"]);
  assert.match(manifest.scripts["test:release-scripts"], /scripts\/ci\/\*\.test\.mjs/);
  assert.match(manifest.scripts["test:release-scripts"], /scripts\/release-consumer\*\.test\.mjs/);
  assert.equal(manifest.scripts["test:codex-packages"], "node scripts/verify-codex-installations.mjs");
  const setup = read(".github/actions/setup-ci/action.yml");
  assert.match(setup.runs.steps.at(-1).run, /pnpm install --frozen-lockfile --ignore-scripts/);
  for (const job of Object.values(workflow.jobs)) for (const step of job.steps) {
    if (step.uses?.startsWith("./")) continue;
    if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/);
  }
});

test("release reuse skips only source checks and keeps fresh policy, audit and immutable consumers", () => {
  assert.deepEqual(publish.permissions, { contents: "read" });
  assert.deepEqual(publish.jobs.verify.permissions, { contents: "read", actions: "read" });
  const steps = publish.jobs.verify.steps;
  const reuse = steps.find(step => step.id === "reuse");
  assert.match(reuse.run, /trusted-main\.mjs --sha "\$GITHUB_SHA"/);
  const source = steps.find(step => step.run?.includes("--skip-policy"));
  assert.equal(source.if, "steps.reuse.outputs.reusable != 'true'");
  for (const name of ["Verify fresh repository policy", "Audit production dependencies", "Require a clean verified checkout",
    "Pack immutable release artifacts", "Verify the actual immutable release combination", "Bind verified artifacts to the uploaded manifest"]) {
    const step = steps.find(entry => entry.name === name);
    assert.ok(step, name);
    assert.equal(step.if, undefined, name);
  }
  const pack = steps.findIndex(step => step.name === "Pack immutable release artifacts");
  const consumers = steps.findIndex(step => step.name === "Verify the actual immutable release combination");
  const upload = steps.findIndex(step => step.name === "Upload release artifacts");
  assert.ok(pack < consumers && consumers < upload);
  const refresh = steps.find(step => step.name === "Revalidate reused source coverage before upload");
  assert.equal(refresh.if, "steps.reuse.outputs.reusable == 'true'");
  assert.match(refresh.run, /\.reusable !== true/);
  assert.equal(publish.jobs.publish.environment, "npm-publish");
  assert.equal(publish.concurrency["cancel-in-progress"], false);
  assert.deepEqual(publish.jobs.publish.permissions, { contents: "write", "id-token": "write" });
  const publication = publish.jobs.publish.steps.find(step => step.name === "Publish exact tarballs and reconcile registry state");
  assert.ok(publication.run.indexOf("release-consumer-receipt.mjs") < publication.run.indexOf("publish-release-artifacts.mjs"));
});

test("Dependabot monthly discovery, update limits and disabled automatic rebasing remain unchanged", () => {
  for (const entry of read(".github/dependabot.yml").updates) {
    assert.equal(entry.schedule.interval, "monthly");
    assert.equal(entry["rebase-strategy"], "disabled");
    assert.equal(entry["open-pull-requests-limit"], 5);
    assert.equal(entry.ignore, undefined);
  }
});
