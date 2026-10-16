import assert from "node:assert/strict";
import test from "node:test";
import { createPlan } from "./plan.mjs";
import { verifyAggregate } from "./aggregate.mjs";

function fixture(event = "push") {
  const plan = { ...createPlan({ mode: "full" }), sourceSha: "b".repeat(40) };
  const outputs = {
    packages: JSON.stringify(plan.packages), suites: JSON.stringify(plan.suites), full: "true",
    has_packages: "true", has_suites: "true",
  };
  return { plan, event, sha: plan.sourceSha, needs: {
    plan: { result: "success", outputs }, policy: { result: "success" },
    packages: { result: "success" }, suites: { result: "success" },
    compatibility: { result: event === "pull_request" ? "skipped" : "success" }, verify: { result: "success" },
  } };
}

test("full main coverage and PR scope have explicit successful aggregation", () => {
  assert.equal(verifyAggregate(fixture()), true);
  assert.equal(verifyAggregate({ ...fixture(), requireFull: true }), true);
  assert.equal(verifyAggregate(fixture("pull_request")), true);
});

test("missing, failed, cancelled and accidentally skipped work cannot be green", () => {
  for (const job of ["plan", "policy", "packages", "suites", "compatibility"]) {
    for (const result of [undefined, "failure", "cancelled", "skipped"]) {
      const input = fixture();
      input.needs[job].result = result;
      assert.throws(() => verifyAggregate(input), new RegExp(job));
    }
  }
  const input = fixture();
  input.needs.verify.result = "failure";
  assert.throws(() => verifyAggregate({ ...input, requireFull: true }), /verify/);
});

test("matrix outputs and source must match the actual plan", () => {
  for (const mutate of [
    f => { f.sha = "a".repeat(40); },
    f => { f.needs.plan.outputs.packages = "[]"; },
    f => { f.needs.plan.outputs.has_suites = "false"; },
    f => { f.needs.plan.outputs.full = "false"; },
    f => { f.event = "unknown"; },
  ]) {
    const input = fixture(); mutate(input);
    assert.throws(() => verifyAggregate(input));
  }
});

test("only an explicitly empty selection permits skipped package and suite matrices", () => {
  const input = fixture("pull_request");
  input.plan = { ...input.plan, mode: "affected", full: false, packages: [], suites: [], reasons: ["Repository documentation only"] };
  Object.assign(input.needs.plan.outputs, { packages: "[]", suites: "[]", has_packages: "false", has_suites: "false", full: "false" });
  Object.assign(input.needs.packages, { result: "skipped" });
  Object.assign(input.needs.suites, { result: "skipped" });
  assert.equal(verifyAggregate(input), true);
  input.event = "push";
  input.needs.compatibility.result = "success";
  assert.throws(() => verifyAggregate(input), /full verification/);
});
