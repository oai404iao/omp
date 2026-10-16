import { createHash } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { workspaces } from "../workspaces.mjs";

const repositoryName = "oai404iao/omp";
const workflowPath = ".github/workflows/ci.yml";
// Deliberately pin the reviewed full-coverage graph, not merely its job names.
// Workflow changes must update this digest and the graph's policy tests together.
export const coverageWorkflowSha256 = "5d7b96ae0ef46a2a8d5d0e8beb1728fcb11d11fe2ca53d4dcc4590adf1260cc7";
export const expectedJobNames = [
  "Verification plan", "Repository policy",
  ...[...workspaces.map(entry => entry.directory), "pi-extensions/pi-local-notify"]
    .map(directory => `Package / ${basename(directory)}`),
  ...["composition", "consumers", "infrastructure"].map(suite => `Suite / ${suite}`),
  "Compatibility / Node 22.19.0 / Pi floor",
  "Compatibility / Node 22.19.0 / Pi target",
  "Compatibility / Node 24.x / Pi floor",
  "Node 22.19.0 / Pi floor", "Node 22.19.0 / Pi target",
  "Node 24.x / Pi floor", "Node 24.x / Pi target",
  "Trusted main coverage / v1",
];
const isId = value => Number.isSafeInteger(value) && value > 0;
const isSha = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);

class EvidenceError extends Error {}
function requireEvidence(condition, reason) {
  if (!condition) throw new EvidenceError(reason);
}

function verifyWorkflow(workflow) {
  requireEvidence(isId(workflow?.id) && workflow.name === "CI" &&
    workflow.path === workflowPath && workflow.state === "active", "untrusted-workflow");
}

function verifyRun(run, { repositoryId, workflow, sha }) {
  requireEvidence(isId(run?.id) && isId(run.run_attempt), "missing-run-identity");
  const sameRepository = value => value?.id === repositoryId && value.full_name === repositoryName;
  requireEvidence(sameRepository(run.repository) && sameRepository(run.head_repository), "untrusted-run-repository");
  requireEvidence(run.event === "push" && run.head_branch === "main", "not-main-push");
  requireEvidence(run.head_sha === sha, "wrong-run-sha");
  requireEvidence(run.workflow_id === workflow.id && run.path === workflowPath && run.name === "CI", "untrusted-run-workflow");
  requireEvidence(run.status === "completed" && run.conclusion === "success", "run-not-successful");
}

function sameRun(left, right) {
  requireEvidence(left.id === right.id && left.run_attempt === right.run_attempt &&
    left.head_sha === right.head_sha, "superseded-run-or-attempt");
}

async function readJobs(get, base, run) {
  const jobs = [];
  let total;
  // A bound is a fail-closed limit, never permission to accept truncated proof.
  for (let page = 1; page <= 20; page++) {
    const result = await get(`${base}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`);
    requireEvidence(Number.isSafeInteger(result?.total_count) && result.total_count > 0 &&
      result.total_count <= 2000 && Array.isArray(result.jobs), "invalid-jobs-page");
    total ??= result.total_count;
    requireEvidence(result.total_count === total && result.jobs.length > 0 &&
      result.jobs.length <= 100, "inconsistent-jobs-pagination");
    jobs.push(...result.jobs);
    requireEvidence(jobs.length <= total, "inconsistent-jobs-pagination");
    if (jobs.length === total) return jobs;
  }
  throw new EvidenceError("incomplete-jobs-pagination");
}

function verifyJobs(jobs, run, sha) {
  const ids = new Set();
  const names = new Map();
  for (const job of jobs) {
    requireEvidence(isId(job?.id) && !ids.has(job.id), "duplicate-or-invalid-job");
    ids.add(job.id);
    // readJobs binds every page to /runs/:id/attempts/:attempt/jobs. GitHub's
    // documented job payload omits run_attempt; validate it if supplied, but
    // never substitute the generic run-jobs endpoint for this attempt binding.
    requireEvidence(job.run_id === run.id && job.head_sha === sha &&
      (!Object.hasOwn(job, "run_attempt") || job.run_attempt === run.run_attempt), "wrong-job-run-or-attempt");
    const matches = names.get(job.name) ?? [];
    matches.push(job);
    names.set(job.name, matches);
  }
  for (const name of expectedJobNames) {
    const matches = names.get(name);
    requireEvidence(matches?.length === 1, "missing-or-duplicate-coverage-job");
    requireEvidence(matches[0].status === "completed" && matches[0].conclusion === "success", "coverage-job-not-successful");
  }
}

function verifySource(source) {
  requireEvidence(source?.type === "file" && source.path === workflowPath &&
    source.encoding === "base64" && typeof source.content === "string" &&
    Number.isSafeInteger(source.size) && source.size > 0 && source.size <= 1_000_000, "invalid-workflow-source");
  const encoded = source.content.replace(/\s/g, "");
  const bytes = Buffer.from(encoded, "base64");
  requireEvidence(bytes.toString("base64") === encoded && bytes.length === source.size,
    "invalid-workflow-source");
  requireEvidence(createHash("sha256").update(bytes).digest("hex") === coverageWorkflowSha256,
    "unrecognized-workflow-coverage-contract");
}

/** All uncertainty selects fresh verification. No logs, artifacts or prior SHA/attempt are proof. */
export async function checkTrustedMain({ sha, repository, repositoryId, get }) {
  const provenance = { sha };
  try {
    requireEvidence(isSha(sha), "invalid-sha");
    requireEvidence(repository === repositoryName && isId(repositoryId), "untrusted-repository-context");
    const base = `/repos/${repositoryName}`;
    const workflow = await get(`${base}/actions/workflows/ci.yml`);
    verifyWorkflow(workflow);
    const query = new URLSearchParams({ branch: "main", event: "push", head_sha: sha, per_page: "1" });
    const latestPath = `${base}/actions/workflows/${workflow.id}/runs?${query}`;
    const readLatest = async () => {
      const result = await get(latestPath);
      requireEvidence(Array.isArray(result?.workflow_runs) && result.workflow_runs.length === 1,
        "no-exact-sha-run");
      const latest = result.workflow_runs[0];
      verifyRun(latest, { repositoryId, workflow, sha });
      return latest;
    };
    const latest = await readLatest();
    Object.assign(provenance, { runId: latest.id, attempt: latest.run_attempt, workflowId: workflow.id });
    const runPath = `${base}/actions/runs/${latest.id}`;
    const run = await get(runPath);
    verifyRun(run, { repositoryId, workflow, sha });
    sameRun(latest, run);
    verifySource(await get(`${base}/contents/${workflowPath}?ref=${sha}`));
    verifyJobs(await readJobs(get, base, run), run, sha);

    // Re-read identities after pagination: a rerun/newer run must not replay the
    // earlier success. Read main last; this conservative proof requires its tip.
    const currentWorkflow = await get(`${base}/actions/workflows/ci.yml`);
    verifyWorkflow(currentWorkflow);
    requireEvidence(currentWorkflow.id === workflow.id, "changed-workflow-identity");
    sameRun(run, await readLatest());
    const currentRun = await get(runPath);
    verifyRun(currentRun, { repositoryId, workflow, sha });
    sameRun(run, currentRun);
    const main = await get(`${base}/git/ref/heads/main`);
    requireEvidence(main?.ref === "refs/heads/main" && main.object?.type === "commit" &&
      main.object.sha === sha, "main-moved-or-unavailable");
    return { reusable: true, reason: "trusted-exact-sha-full-coverage", ...provenance,
      workflowSha256: coverageWorkflowSha256 };
  } catch (error) {
    // API responses/errors may contain credentials or private endpoint details.
    return { reusable: false, reason: error instanceof EvidenceError ? error.message : "api-unavailable", ...provenance };
  }
}

export function createGithubGet(env, fetchImpl = fetch) {
  requireEvidence((env.GITHUB_API_URL ?? "https://api.github.com") === "https://api.github.com",
    "untrusted-api-endpoint");
  requireEvidence(typeof env.GITHUB_TOKEN === "string" && env.GITHUB_TOKEN.length > 0, "missing-api-token");
  return async path => {
    requireEvidence(path.startsWith(`/repos/${repositoryName}/`) && !/[\r\n#]/.test(path), "invalid-api-path");
    const response = await fetchImpl(`https://api.github.com${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Cache-Control": "no-cache",
      },
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(30_000),
    });
    requireEvidence(response.ok && response.status === 200, "api-read-failed");
    return response.json();
  };
}

export function parseArgs(args, env = process.env) {
  const options = {};
  const flags = new Map([["--sha", "sha"], ["--github-output", "githubOutput"], ["--output", "output"]]);
  for (let index = 0; index < args.length; index++) {
    const key = flags.get(args[index]);
    if (!key || Object.hasOwn(options, key) || !args[index + 1] || args[index + 1].startsWith("--")) {
      throw new Error("Expected unique --sha SHA, --github-output PATH or --output PATH");
    }
    options[key] = args[++index];
  }
  options.sha ??= env.GITHUB_SHA;
  options.githubOutput ??= env.GITHUB_OUTPUT;
  if (!isSha(options.sha)) throw new Error("Expected an exact lowercase 40-character commit SHA");
  if (options.output && options.githubOutput && resolve(options.output) === resolve(options.githubOutput)) {
    throw new Error("Evidence and GitHub output paths must differ");
  }
  return options;
}

export async function main(args = process.argv.slice(2), env = process.env, fetchImpl = fetch) {
  const options = parseArgs(args, env);
  let evidence;
  try {
    evidence = await checkTrustedMain({ sha: options.sha, repository: env.GITHUB_REPOSITORY,
      repositoryId: Number(env.GITHUB_REPOSITORY_ID), get: createGithubGet(env, fetchImpl) });
  } catch (error) {
    evidence = { reusable: false, reason: error instanceof EvidenceError ? error.message : "api-unavailable", sha: options.sha };
  }
  if (options.output) writeFileSync(options.output, `${JSON.stringify(evidence, null, 2)}\n`);
  if (options.githubOutput) appendFileSync(options.githubOutput,
    `reusable=${evidence.reusable}\nreason=${evidence.reason}\nsha=${evidence.sha}\nrun_id=${evidence.runId ?? ""}\nattempt=${evidence.attempt ?? ""}\n`);
  console.log(JSON.stringify(evidence));
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
