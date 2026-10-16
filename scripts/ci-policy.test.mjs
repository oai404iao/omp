import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { root } from "./workspaces.mjs";

const workflow = parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"));
const steps = workflow.jobs.verify.steps;
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

test("only Node24/target executes PR checks, all four main/manual legs execute", () => {
  const scope = steps.find(step => step.id === "scope");
  const directory = mkdtempSync(join(tmpdir(), "omp-ci-scope-"));
  try {
    for (const event of ["pull_request", "push", "workflow_dispatch"]) {
      for (const node of workflow.jobs.verify.strategy.matrix.node) {
        for (const pi of workflow.jobs.verify.strategy.matrix.pi) {
          const output = join(directory, `${event}-${node}-${pi}`);
          const result = spawnSync("bash", ["-e", "-c", scope.run], {
            encoding: "utf8", env: { ...process.env, CI_EVENT: event, CI_NODE: node, CI_PI: pi, GITHUB_OUTPUT: output },
          });
          assert.equal(result.status, 0, result.stderr);
          const expected = event !== "pull_request" || (node === "24.x" && pi === "target");
          assert.equal(readFileSync(output, "utf8").trim(), `run=${expected}`);
          if (!expected) assert.match(result.stdout, /Compatibility leg deferred/);
        }
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("legacy required contexts remain and every expensive step honors the scope", () => {
  assert.equal(workflow.jobs.verify.name, "Node ${{ matrix.node }} / Pi ${{ matrix.pi }}");
  assert.deepEqual(workflow.jobs.verify.strategy.matrix, { node: ["22.19.0", "24.x"], pi: ["floor", "target"] });
  assert.deepEqual(workflow.permissions, { contents: "read" });
  for (const step of steps.filter(step => step.id !== "scope")) {
    assert.ok(step.if.includes("steps.scope.outputs.run == 'true'"), step.name);
  }
  assert.equal(steps.find(step => step.name === "Upload baseline diagnostics").if,
    "always() && steps.scope.outputs.run == 'true'");
});

test("only the canonical target leg runs full consumers; floor reuse is explicit", () => {
  const baseline = steps.find(step => step.run === "node scripts/test-pi-baselines.mjs ${{ matrix.pi }}");
  assert.equal(baseline.env.OMP_PI_REUSE_TARGET, "1");
  assert.equal(baseline.env.OMP_CODEX_CONSUMER_MODE,
    "${{ matrix.node == '24.x' && matrix.pi == 'target' && 'full' || 'smoke' }}");
  assert.equal(manifest.scripts["test:codex-packages"], "node scripts/verify-codex-installations.mjs");
});

test("cheap package policy checks precede any runtime or package test suite", () => {
  const commands = manifest.scripts.ci.split(" && ");
  const pack = commands.indexOf("pnpm run pack:check");
  const license = commands.indexOf("pnpm run license:check");
  assert.ok(pack >= 0 && license >= 0);
  for (const script of ["check:pi-baseline", "check", "test:codex-composition", "test:release-scripts", "test:codex-packages"]) {
    const index = commands.indexOf(`pnpm run ${script}`);
    assert.ok(index > pack && index > license, script);
  }
});

test("Dependabot keeps monthly discovery but disables automatic rebasing", () => {
  const config = parse(readFileSync(join(root, ".github/dependabot.yml"), "utf8"));
  for (const entry of config.updates) {
    assert.equal(entry.schedule.interval, "monthly");
    assert.equal(entry["rebase-strategy"], "disabled");
    assert.equal(entry["open-pull-requests-limit"], 5);
    assert.equal(entry.ignore, undefined);
  }
});
