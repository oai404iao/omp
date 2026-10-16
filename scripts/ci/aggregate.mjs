import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validatePlan } from "./plan.mjs";

/** A skipped matrix is legitimate only when the validated plan selected no work. */
export function verifyAggregate({ plan, needs, event, sha, requireFull = false }) {
  validatePlan(plan);
  assert.match(sha ?? "", /^[a-f0-9]{40}$/);
  assert.equal(plan.sourceSha, sha, "verification plan belongs to another source revision");
  assert.ok(["pull_request", "push", "workflow_dispatch"].includes(event), "unknown CI event");
  const expect = (job, result) => assert.equal(needs?.[job]?.result, result, `${job} must conclude ${result}`);
  expect("plan", "success");
  expect("policy", "success");
  for (const key of ["packages", "suites"]) {
    const selected = plan[key];
    const outputs = needs.plan.outputs;
    assert.equal(outputs?.[key], JSON.stringify(selected), `${key} matrix differs from plan`);
    assert.equal(outputs?.[`has_${key}`], String(selected.length > 0), `${key} presence differs from plan`);
    expect(key, selected.length > 0 ? "success" : "skipped");
  }
  assert.equal(needs.plan.outputs.full, String(plan.full), "full coverage output differs from plan");
  expect("compatibility", event === "pull_request" ? "skipped" : "success");
  if (event !== "pull_request" || requireFull) {
    assert.equal(plan.mode, "full", "main/manual CI requires the full verification plan");
    assert.equal(plan.full, true, "full coverage is required");
  }
  if (requireFull) expect("verify", "success");
  return true;
}

export function main(env = process.env) {
  verifyAggregate({
    plan: JSON.parse(env.VERIFICATION_PLAN), needs: JSON.parse(env.CI_NEEDS),
    event: env.CI_EVENT, sha: env.GITHUB_SHA, requireFull: env.REQUIRE_FULL_COVERAGE === "1",
  });
  console.log("All planned verification tasks completed successfully.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
