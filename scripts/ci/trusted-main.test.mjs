import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  checkTrustedMain, coverageWorkflowSha256, createGithubGet, expectedJobNames, main, parseArgs,
} from "./trusted-main.mjs";

const sha = "a".repeat(40);
const otherSha = "b".repeat(40);
const repository = "oai404iao/omp";
const repositoryId = 123;
const source = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url));

function fixture() {
  const workflow = { id: 789, name: "CI", path: ".github/workflows/ci.yml", state: "active" };
  const run = {
    id: 456, run_attempt: 2, name: "CI", workflow_id: workflow.id, path: workflow.path,
    repository: { id: repositoryId, full_name: repository },
    head_repository: { id: repositoryId, full_name: repository },
    event: "push", head_branch: "main", head_sha: sha, status: "completed", conclusion: "success",
  };
  return {
    sha, repository, repositoryId, workflow, run, latest: structuredClone(run), mainSha: sha,
    source: { type: "file", path: workflow.path, encoding: "base64", size: source.length, content: source.toString("base64") },
    jobs: expectedJobNames.map((name, index) => ({
      id: index + 1, name, run_id: run.id, run_attempt: run.run_attempt, head_sha: sha,
      status: "completed", conclusion: "success",
    })),
  };
}

function apiFixture(input, hook) {
  const calls = [];
  const get = async path => {
    calls.push(path);
    hook?.(path, calls);
    if (path.endsWith("/actions/workflows/ci.yml")) return structuredClone(input.workflow);
    if (path.endsWith("/actions/runs/456")) return structuredClone(input.run);
    if (path.includes("/actions/workflows/789/runs?")) return { workflow_runs: input.latest ? [structuredClone(input.latest)] : [] };
    if (path.includes("/contents/")) return structuredClone(input.source);
    if (path.includes("/attempts/2/jobs?")) {
      const page = Number(new URL(`https://api.github.com${path}`).searchParams.get("page"));
      return { total_count: input.jobs.length, jobs: structuredClone(input.jobs.slice((page - 1) * 100, page * 100)) };
    }
    if (path.endsWith("/git/ref/heads/main")) return { ref: "refs/heads/main", object: { type: "commit", sha: input.mainSha } };
    throw new Error(`Unexpected mocked request ${path}`);
  };
  return { get, calls };
}

async function check(input, hook) {
  return checkTrustedMain({ ...input, ...apiFixture(input, hook) });
}

test("full-coverage workflow graph is pinned, not accepted solely by job names", () => {
  assert.equal(createHash("sha256").update(source).digest("hex"), coverageWorkflowSha256,
    "Review the CI coverage graph and update its trusted-main digest together");
  assert.equal(expectedJobNames.length, 22);
  assert.equal(new Set(expectedJobNames).size, expectedJobNames.length);
});

test("accepts exact current main SHA with latest successful run/attempt and complete coverage", async () => {
  const input = fixture();
  const api = apiFixture(input);
  const evidence = await checkTrustedMain({ ...input, ...api });
  assert.deepEqual(evidence, {
    reusable: true, reason: "trusted-exact-sha-full-coverage", sha, runId: 456, attempt: 2,
    workflowId: 789, workflowSha256: coverageWorkflowSha256,
  });
  assert.equal(api.calls.filter(path => path.includes("/runs?")).length, 2);
  assert.equal(api.calls.filter(path => path.endsWith("/actions/runs/456")).length, 2);
  assert(api.calls.some(path => path.endsWith(`/runs?branch=main&event=push&head_sha=${sha}&per_page=1`)));
  assert(api.calls.some(path => path.endsWith("/attempts/2/jobs?per_page=100&page=1")));
  assert.equal(api.calls.at(-1), "/repos/oai404iao/omp/git/ref/heads/main");
});

test("documented jobs without run_attempt retain provenance from the exact attempt endpoint", async () => {
  const input = fixture();
  for (const job of input.jobs) delete job.run_attempt;
  const api = apiFixture(input);
  const evidence = await checkTrustedMain({ ...input, ...api });
  assert.equal(evidence.reusable, true);
  assert.equal(evidence.attempt, 2);
  const jobRequests = api.calls.filter(path => path.includes("/jobs?"));
  assert.deepEqual(jobRequests, ["/repos/oai404iao/omp/actions/runs/456/attempts/2/jobs?per_page=100&page=1"]);
});

for (const [label, change] of [
  ["fork context", input => { input.repository = "fork/omp"; }],
  ["missing repository ID", input => { delete input.repositoryId; }],
  ["invalid repository ID", input => { input.repositoryId = 0; }],
  ["non-integer repository ID", input => { input.repositoryId = "123"; }],
  ["wrong workflow path", input => { input.workflow.path = ".github/workflows/other.yml"; }],
  ["wrong workflow name", input => { input.workflow.name = "Untrusted"; }],
  ["disabled workflow", input => { input.workflow.state = "disabled_manually"; }],
  ["missing workflow ID", input => { delete input.workflow.id; }],
  ["no exact SHA run", input => { delete input.latest; }],
  ["current main changed", input => { input.mainSha = otherSha; }],
  ["changed workflow source with identical job names", input => {
    const changed = Buffer.concat([source, Buffer.from("\n# changed graph\n")]);
    input.source.content = changed.toString("base64"); input.source.size = changed.length;
  }],
  ["malformed workflow encoding", input => { input.source.content += "invalid!"; }],
  ["wrong workflow source path", input => { input.source.path = "other.yml"; }],
  ["missing source proof", input => { input.source = undefined; }],
]) {
  test(`does not reuse ${label}`, async () => {
    const input = fixture(); change(input);
    assert.equal((await check(input)).reusable, false);
  });
}

for (const candidate of ["latest", "run"]) {
  for (const [label, change] of [
    ["fork repository ID", run => { run.repository.id = 444; }],
    ["fork repository name", run => { run.repository.full_name = "fork/omp"; }],
    ["fork head repository", run => { run.head_repository.id = 444; }],
    ["fork head repository name", run => { run.head_repository.full_name = "fork/omp"; }],
    ["PR event", run => { run.event = "pull_request"; }],
    ["manual event", run => { run.event = "workflow_dispatch"; }],
    ["wrong branch", run => { run.head_branch = "feature"; }],
    ["wrong SHA", run => { run.head_sha = otherSha; }],
    ["missing attempt", run => { delete run.run_attempt; }],
    ["earlier attempt", run => { run.run_attempt = 1; }],
    ["wrong workflow ID", run => { run.workflow_id = 333; }],
    ["wrong path", run => { run.path = ".github/workflows/other.yml"; }],
    ["wrong name", run => { run.name = "Other"; }],
    ["failure", run => { run.conclusion = "failure"; }],
    ["cancelled", run => { run.conclusion = "cancelled"; }],
    ["skipped", run => { run.conclusion = "skipped"; }],
    ["pending", run => { run.status = "in_progress"; run.conclusion = null; }],
  ]) {
    test(`rejects ${candidate}: ${label}`, async () => {
      const input = fixture(); change(input[candidate]);
      assert.equal((await check(input)).reusable, false);
    });
  }
}

for (const name of expectedJobNames) {
  test(`missing coverage cannot be replaced by unknown extras: ${name}`, async () => {
    const input = fixture();
    input.jobs.find(job => job.name === name).name = "Unknown successful job";
    assert.equal((await check(input)).reusable, false);
  });
}

for (const [label, change] of [
  ["duplicate expected name", input => { input.jobs.push({ ...input.jobs[0], id: 900 }); }],
  ["duplicate job ID", input => { input.jobs.push({ ...input.jobs[0], name: "Extra" }); }],
  ["failed job", input => { input.jobs[2].conclusion = "failure"; }],
  ["skipped job", input => { input.jobs[2].conclusion = "skipped"; }],
  ["cancelled job", input => { input.jobs[2].conclusion = "cancelled"; }],
  ["pending job", input => { input.jobs[2].status = "in_progress"; }],
  ["job from earlier attempt", input => { input.jobs[2].run_attempt = 1; }],
  ["job with null explicit attempt", input => { input.jobs[2].run_attempt = null; }],
  ["job from earlier run", input => { input.jobs[2].run_id = 333; }],
  ["job from different SHA", input => { input.jobs[2].head_sha = otherSha; }],
]) {
  test(`rejects ${label}`, async () => {
    const input = fixture(); change(input);
    assert.equal((await check(input)).reusable, false);
  });
}

test("pagination reads every attempt job and does not silently truncate", async () => {
  const input = fixture();
  for (let index = 0; index < 110; index++) input.jobs.unshift({ ...input.jobs.at(-1), id: index + 100, name: `Extra ${index}` });
  const api = apiFixture(input);
  assert.equal((await checkTrustedMain({ ...input, ...api })).reusable, true);
  assert.equal(api.calls.filter(path => path.includes("/jobs?")).length, 2);
  input.jobs.at(-1).conclusion = "failure";
  assert.equal((await check(input)).reusable, false);
});

test("unknown extra jobs do not invalidate full coverage or substitute for it", async () => {
  const input = fixture();
  input.jobs.push({ ...input.jobs[0], id: 999, name: "Unrelated optional job", conclusion: "skipped" });
  assert.equal((await check(input)).reusable, true);
});

test("changing page totals and a failed later API page cannot accept partial coverage", async () => {
  for (const fail of [false, true]) {
    const input = fixture(); const api = apiFixture(input);
    const evidence = await checkTrustedMain({ ...input, get: async path => {
      if (!path.includes("/jobs?")) return api.get(path);
      if (path.endsWith("page=1")) return { total_count: 23, jobs: input.jobs };
      if (fail) throw new Error("unavailable second page");
      return { total_count: 24, jobs: [{ ...input.jobs[0], id: 999, name: "Extra" }] };
    } });
    assert.equal(evidence.reusable, false);
  }
});

for (const result of [
  { total_count: 2001, jobs: [] }, { total_count: 22, jobs: [] },
  { total_count: 0, jobs: [] }, { total_count: -1, jobs: [] },
  { total_count: 1, jobs: fixture().jobs }, { jobs: fixture().jobs },
]) {
  test(`incomplete or excessive job pagination fails closed (${JSON.stringify(result).slice(0, 50)})`, async () => {
    const input = fixture(); const api = apiFixture(input);
    assert.equal((await checkTrustedMain({ ...input, get: path => path.includes("/jobs?") ? result : api.get(path) })).reusable, false);
  });
}

for (const mutation of ["newer-run", "new-attempt", "failed-current-attempt", "disabled-workflow", "main-moved"]) {
  test(`final revalidation rejects concurrent ${mutation}`, async () => {
    const input = fixture();
    const evidence = await check(input, path => {
      if (!path.includes("/jobs?")) return;
      if (mutation === "newer-run") input.latest.id = 999;
      if (mutation === "new-attempt") input.run.run_attempt = input.latest.run_attempt = 3;
      if (mutation === "failed-current-attempt") input.run.conclusion = "failure";
      if (mutation === "disabled-workflow") input.workflow.state = "disabled_manually";
      if (mutation === "main-moved") input.mainSha = otherSha;
    });
    assert.equal(evidence.reusable, false);
  });
}

test("API uncertainty fails closed without retaining error bodies, tokens or endpoints", async () => {
  const evidence = await checkTrustedMain({ ...fixture(), get: async () => { throw new Error("SECRET_TOKEN private.example"); } });
  assert.deepEqual(evidence, { reusable: false, reason: "api-unavailable", sha });
});

test("GitHub client uses only HTTPS canonical API, no redirects and read-only GET", async () => {
  let called = 0;
  const get = createGithubGet({ GITHUB_TOKEN: "SECRET" }, async (url, options) => {
    called++;
    assert.equal(url, "https://api.github.com/repos/oai404iao/omp/actions/workflows/ci.yml");
    assert.equal(options.redirect, "error"); assert.equal(options.cache, "no-store");
    assert.equal(options.method, undefined); assert.equal(options.headers.Authorization, "Bearer SECRET");
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  });
  assert.deepEqual(await get("/repos/oai404iao/omp/actions/workflows/ci.yml"), { ok: true });
  assert.equal(called, 1);
  await assert.rejects(get("https://evil.example/"));
  for (const endpoint of ["http://api.github.com", "https://evil.example", "https://api.github.com/", "https://api.github.com@evil.example"]) {
    assert.throws(() => createGithubGet({ GITHUB_TOKEN: "SECRET", GITHUB_API_URL: endpoint }));
  }
  const failing = createGithubGet({ GITHUB_TOKEN: "SECRET" }, async () => ({ ok: false, status: 302 }));
  await assert.rejects(failing("/repos/oai404iao/omp/actions/workflows/ci.yml"));
});

test("invalid local CLI arguments fail instead of selecting verification", () => {
  for (const args of [[], ["--unknown", "x"], ["--sha"], ["--sha", "main"],
    ["--sha", sha, "--sha", sha], ["--sha", sha, "--output", "same", "--github-output", "same"]]) {
    assert.throws(() => parseArgs(args, {}));
  }
  assert.equal(parseArgs([], { GITHUB_SHA: sha }).sha, sha);
  const result = spawnSync(process.execPath, ["scripts/ci/trusted-main.mjs", "--sha", "main"], { encoding: "utf8" });
  assert.equal(result.status, 1);
});

test("CLI emits sanitized false evidence and exits zero without an available API token", async () => {
  const root = join(homedir(), ".local/state/agents/tmp");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(root, "trusted-main-tests."));
  const output = join(directory, "evidence.json");
  const githubOutput = join(directory, "github-output");
  const evidence = await main(["--sha", sha, "--output", output, "--github-output", githubOutput], {});
  assert.equal(evidence.reusable, false);
  assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), evidence);
  assert.match(readFileSync(githubOutput, "utf8"), /^reusable=false\nreason=missing-api-token\n/);
  const result = spawnSync(process.execPath, ["scripts/ci/trusted-main.mjs", "--sha", sha], {
    encoding: "utf8", env: { ...process.env, GITHUB_TOKEN: "", GITHUB_OUTPUT: "" },
  });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).reusable, false);

  const input = fixture(); const api = apiFixture(input);
  const success = await main(["--sha", sha, "--output", output, "--github-output", githubOutput], {
    GITHUB_TOKEN: "NEVER_PERSIST_THIS", GITHUB_REPOSITORY: repository, GITHUB_REPOSITORY_ID: String(repositoryId),
  }, async url => ({ ok: true, status: 200, json: () => api.get(new URL(url).pathname + new URL(url).search) }));
  assert.equal(success.reusable, true);
  assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), success);
  assert.match(readFileSync(githubOutput, "utf8"), /reusable=true\n/);
  assert(!readFileSync(output, "utf8").includes("NEVER_PERSIST_THIS"));
  assert(!readFileSync(githubOutput, "utf8").includes("NEVER_PERSIST_THIS"));
});
