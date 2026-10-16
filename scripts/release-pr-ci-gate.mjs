import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repositoryName = "oai404iao/omp";
const workflowPath = ".github/workflows/ci.yml";
const isId = value => Number.isSafeInteger(value) && value > 0;

function requireValue(condition, message) {
  if (!condition) throw new Error(`Release PR CI gate: ${message}`);
}

/** Pure fail-closed policy; all API records must come from this repository. */
export function verifyCiRun({
  event, repository, repositoryId, contextSha, workflow, run, latestRun, mainSha, expectedSha,
}) {
  requireValue(repository === repositoryName && isId(repositoryId), "untrusted repository context");
  const sameRepository = value => value?.id === repositoryId && value?.full_name === repository;
  requireValue(event?.action === "completed" && sameRepository(event.repository), "untrusted completion event repository");
  requireValue(isId(workflow?.id) && workflow.name === "CI" && workflow.path === workflowPath &&
    workflow.state === "active", "canonical CI workflow identity mismatch");

  const reported = event.workflow_run;
  for (const candidate of [reported, run, latestRun]) {
    requireValue(isId(candidate?.id) && isId(candidate?.run_attempt), "missing run identity/attempt");
    requireValue(sameRepository(candidate.repository) && sameRepository(candidate.head_repository),
      "CI run repository/head repository mismatch");
    requireValue(candidate.event === "push" && candidate.head_branch === "main", "CI must be a main push");
    requireValue(candidate.status === "completed" && candidate.conclusion === "success", "CI did not succeed");
    requireValue(candidate.workflow_id === workflow.id && candidate.path === workflowPath && candidate.name === "CI",
      "CI run workflow identity mismatch");
    requireValue(/^[a-f0-9]{40}$/.test(candidate.head_sha ?? ""), "invalid CI head SHA");
  }
  for (const candidate of [reported, latestRun]) {
    requireValue(candidate.id === run.id && candidate.run_attempt === run.run_attempt &&
      candidate.head_sha === run.head_sha, "stale or replayed CI run/attempt");
  }
  requireValue(mainSha === run.head_sha, "main moved since CI; wait for its successful run");
  // Changesets resets to context.sha, not necessarily the checkout's HEAD. Never
  // substitute GITHUB_SHA to make an unrelated workflow context appear verified.
  requireValue(contextSha === run.head_sha, "workflow context SHA differs from verified CI head");
  requireValue(expectedSha === undefined || expectedSha === run.head_sha, "verified head changed before write");
  return run.head_sha;
}

/** Read fresh canonical run/workflow identity, then read live main last. */
export async function checkCiGate({ event, repository, repositoryId, contextSha, expectedSha, get }) {
  requireValue(repository === repositoryName && isId(repositoryId), "untrusted repository context");
  requireValue(isId(event?.workflow_run?.id), "missing triggering run ID");
  const base = `/repos/${repository}`;
  const workflow = await get(`${base}/actions/workflows/ci.yml`);
  requireValue(isId(workflow?.id), "missing canonical workflow ID");
  const run = await get(`${base}/actions/runs/${event.workflow_run.id}`);
  requireValue(/^[a-f0-9]{40}$/.test(run?.head_sha ?? ""), "invalid CI head SHA");
  // Do not select the latest *successful* run: a newer pending/failed run must
  // prevent replaying an earlier success for the same head.
  const query = new URLSearchParams({ branch: "main", event: "push", head_sha: run.head_sha, per_page: "1" });
  const latest = await get(`${base}/actions/workflows/${workflow.id}/runs?${query}`);
  const main = await get(`${base}/git/ref/heads/main`);
  requireValue(main?.ref === "refs/heads/main" && main.object?.type === "commit", "invalid main ref");
  return verifyCiRun({
    event, repository, repositoryId, contextSha, workflow, run,
    latestRun: latest?.workflow_runs?.[0], mainSha: main.object.sha, expectedSha,
  });
}

export async function main(env = process.env) {
  requireValue(env.GITHUB_EVENT_NAME === "workflow_run", "expected workflow_run event");
  requireValue(Boolean(env.GITHUB_TOKEN), "missing API token");
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  const sha = await checkCiGate({
    event,
    repository: env.GITHUB_REPOSITORY,
    repositoryId: Number(env.GITHUB_REPOSITORY_ID),
    contextSha: env.GITHUB_SHA,
    expectedSha: env.VERIFIED_HEAD_SHA,
    get: async path => {
      const response = await fetch(`${env.GITHUB_API_URL ?? "https://api.github.com"}${path}`, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "Cache-Control": "no-cache",
        },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      requireValue(response.ok, `GitHub API read failed (${response.status})`);
      return response.json();
    },
  });
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `sha=${sha}\n`);
  console.log(`Verified successful canonical main-push CI at ${sha}`);
  return sha;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
