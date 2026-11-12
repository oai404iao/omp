import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { releaseFinalizationIssues } from "./release-result.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const finalizeScript = resolve(root, "scripts/finalize-github-releases.mjs");

function readyResult(overrides = {}) {
  return {
    schemaVersion: 1,
    commit: "0123456789012345678901234567890123456789",
    ok: true,
    releases: [
      {
        name: "@oai404iao/example",
        version: "1.0.0",
        tag: "@oai404iao/example@1.0.0",
        notes: "Example release",
        prerelease: false,
        sourceCommit: "0123456789012345678901234567890123456789",
      },
    ],
    unresolved: [],
    publishWarnings: [],
    ...overrides,
  };
}

test("release finalization rejects incomplete and warning-bearing results", () => {
  assert.deepEqual(
    releaseFinalizationIssues(
      readyResult({ ok: false, unresolved: ["@oai404iao/example@1.0.0 is not published"] }),
    ),
    [
      "release result is not marked ok",
      "@oai404iao/example@1.0.0 is not published",
    ],
  );
  assert.deepEqual(
    releaseFinalizationIssues(
      readyResult({
        publishWarnings: [{ name: "@oai404iao/example", message: "network timeout" }],
      }),
    ),
    ["npm publish reported a warning for @oai404iao/example: network timeout"],
  );
  assert.deepEqual(releaseFinalizationIssues({ schemaVersion: 1, releases: [] }), [
    "release result is malformed",
  ]);
});

function finalizeFixture(releaseResult, { existing, remoteCommit, localCommit, lookupError } = {}) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "omp-release-result-"));
  try {
    const binaryDirectory = join(temporaryDirectory, "bin");
    const resultPath = join(temporaryDirectory, "result.json");
    const callLog = join(temporaryDirectory, "calls.log");

    mkdirSync(binaryDirectory);
    writeFileSync(
      join(binaryDirectory, "git"),
      [
        "#!/bin/sh",
        "printf 'git %s\\n' \"$*\" >> \"$CALL_LOG\"",
        'if [ "$1" = "rev-parse" ]; then printf "%s\\n" "$LOCAL_COMMIT"; fi',
        'if [ "$1" = "ls-remote" ] && [ -n "$REMOTE_COMMIT" ]; then printf "%s\\trefs/tags/@oai404iao/example@1.0.0\\n" "$REMOTE_COMMIT"; fi',
        "exit 0",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(binaryDirectory, "gh"),
      [
        "#!/bin/sh",
        "printf 'gh %s\\n' \"$*\" >> \"$CALL_LOG\"",
        'if [ "$2" = "view" ]; then',
        '  if [ -n "$EXISTING" ]; then printf "%s\\n" "$EXISTING"; exit 0; fi',
        '  printf "%s\\n" "$LOOKUP_ERROR" >&2; exit 1',
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(join(binaryDirectory, "git"), 0o755);
    chmodSync(join(binaryDirectory, "gh"), 0o755);
    writeFileSync(resultPath, `${JSON.stringify(releaseResult)}\n`);

    const result = spawnSync(process.execPath, [finalizeScript, resultPath], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binaryDirectory}:${process.env.PATH}`,
        CALL_LOG: callLog,
        EXISTING: existing ? JSON.stringify(existing) : "",
        REMOTE_COMMIT: remoteCommit ?? "",
        LOCAL_COMMIT: localCommit ?? readyResult().commit,
        LOOKUP_ERROR: lookupError ?? "release not found",
      },
    });

    return { ...result, calls: existsSync(callLog) ? readFileSync(callLog, "utf8") : "" };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

test("incomplete and pending finalization invoke neither git nor gh", { skip: process.platform === "win32" }, () => {
  for (const state of ["failed", "pending-visibility"]) {
    const result = finalizeFixture(readyResult({ state, ok: false, unresolved: ["not verified"] }));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /tags and GitHub Releases were not finalized/);
    assert.equal(result.calls, "");
  }
});

test("ready finalization atomically pushes tags before creating a release", { skip: process.platform === "win32" }, () => {
  const result = finalizeFixture(readyResult());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.calls, /git push --atomic origin @oai404iao\/example@1\.0\.0/);
  assert.match(result.calls, /gh release view .* --json tagName,name,body,isPrerelease,isDraft/);
  assert.match(result.calls, /gh release create @oai404iao\/example@1\.0\.0/);
  assert.ok(result.calls.indexOf("git push") < result.calls.indexOf("gh release create"));
});

const existingRelease = () => ({ tagName: readyResult().releases[0].tag, name: readyResult().releases[0].tag,
  body: "Example release\n", isDraft: false, isPrerelease: false });

test("matching existing release is verified and left unchanged", () => {
  const result = finalizeFixture(readyResult(), { existing: existingRelease(), remoteCommit: readyResult().commit });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.calls, /gh release (edit|create)/);
});

test("empty title and notes and missing prerelease marker are repaired", () => {
  const releaseResult = readyResult();
  releaseResult.releases[0].prerelease = true;
  const result = finalizeFixture(releaseResult, { existing: { ...existingRelease(), name: "", body: "" } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.calls, /gh release edit .* --title .* --notes-file .* --prerelease/);
});

test("conflicting release metadata fails before pushing tags or editing", () => {
  for (const overrides of [{ tagName: "wrong" }, { name: "Different title" }, { body: "Different notes" },
    { isDraft: true }, { isPrerelease: true }]) {
    const result = finalizeFixture(readyResult(), { existing: { ...existingRelease(), ...overrides } });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.calls, /git push|gh release (edit|create)/);
  }
});

test("conflicting local or remote tags fail before push", () => {
  for (const overrides of [{ localCommit: "a".repeat(40) }, { remoteCommit: "b".repeat(40) }]) {
    const result = finalizeFixture(readyResult(), overrides);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /points to another commit/);
    assert.doesNotMatch(result.calls, /git push|gh release (edit|create)/);
  }
});

test("GitHub lookup errors never authorize creating a release", () => {
  const result = finalizeFixture(readyResult(), { lookupError: "HTTP 403: forbidden" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Cannot verify GitHub Release/);
  assert.doesNotMatch(result.calls, /git push|gh release (edit|create)/);
});

test("release repair never overwrites already populated matching fields", () => {
  for (const [missing, flag, preservedFlag] of [["name", "--title", "--notes-file"], ["body", "--notes-file", "--title"]]) {
    const result = finalizeFixture(readyResult(), { existing: { ...existingRelease(), [missing]: "" } });
    assert.equal(result.status, 0, result.stderr);
    const edit = result.calls.split("\n").find(line => line.startsWith("gh release edit"));
    assert.ok(edit.includes(flag));
    assert.ok(!edit.includes(preservedFlag));
  }
});

const publicationWorkflow = parse(readFileSync(resolve(root, ".github/workflows/publish.yml"), "utf8"));

test("recovery preserves original artifacts, gates and receipt checks without repacking", () => {
  const { verify, publish } = publicationWorkflow.jobs;
  const step = (job, name) => job.steps.find(step => step.name === name);
  assert.equal(step(verify, "Pack immutable release artifacts").if, "inputs.recovery_run == ''");
  assert.equal(step(verify, "Verify the actual immutable release combination").if, "inputs.recovery_run == ''");
  const download = step(verify, "Download original immutable artifacts for verify-only recovery");
  assert.equal(download.if, "inputs.recovery_run != ''");
  assert.equal(download.with.name, "npm-release-${{ github.sha }}");
  assert.equal(download.with["run-id"], "${{ inputs.recovery_run }}");
  assert.equal(download.with.repository, "${{ github.repository }}");
  assert.match(step(verify, "Bind verified artifacts to the uploaded manifest").run, /release-consumer-receipt/);
  const publisher = step(publish, "Publish exact tarballs and reconcile registry state");
  assert.equal(publisher.env.RELEASE_VERIFY_ONLY, "${{ inputs.recovery_run != '' && 'true' || 'false' }}");
  assert.match(publisher.run, /release-consumer-receipt/);
  assert.equal(step(publish, "Push tags and create idempotent GitHub Releases").if, "steps.reconciliation.outputs.state == 'verified'");
  assert.equal(step(publish, "Preserve publication receipts and immutable recovery artifacts").if, "always()");
  assert.equal(step(publish, "Summarize registry reconciliation").if, "always()");
  assert.equal(step(publish, "Enforce release safety gates").env.PUBLISH_CONFIRMATION, "${{ inputs.confirm }}");
  assert.equal(publish.environment, "npm-publish");
  assert.equal(publish.needs, "verify");
});

test("recovery run trust validation rejects foreign repository, workflow, source and event", () => {
  const guard = publicationWorkflow.jobs.verify.steps.find(step => step.name === "Validate the original recovery run");
  const source = guard.run.match(/<<'NODE'\n([\s\S]*?)\nNODE/)[1];
  const directory = mkdtempSync(join(tmpdir(), "omp-recovery-guard-"));
  try {
    const gh = join(directory, "gh");
    writeFileSync(gh, `#!${process.execPath}\nconsole.log(process.argv.at(-1).endsWith('/publish.yml') ? process.env.WORKFLOW_DETAIL : process.env.RUN_DETAIL);\n`);
    chmodSync(gh, 0o755);
    const workflow = { id: 23, path: ".github/workflows/publish.yml" };
    const run = { id: 123, repository: { full_name: "oai404iao/omp" }, head_repository: { full_name: "oai404iao/omp" },
      workflow_id: workflow.id, path: workflow.path, event: "workflow_dispatch", head_branch: "main", head_sha: readyResult().commit, status: "completed" };
    const execute = (changes = {}, id = "123") => spawnSync(process.execPath, ["--input-type=module", "-e", source], {
      encoding: "utf8", env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, RECOVERY_RUN: id,
        GITHUB_REPOSITORY: "oai404iao/omp", GITHUB_SHA: readyResult().commit,
        WORKFLOW_DETAIL: JSON.stringify(workflow), RUN_DETAIL: JSON.stringify({ ...run, ...changes }) },
    });
    const valid = execute();
    assert.equal(valid.status, 0, valid.stderr);
    for (const changes of [{ repository: { full_name: "fork/omp" } }, { head_repository: { full_name: "fork/omp" } },
      { workflow_id: 99 }, { path: ".github/workflows/ci.yml" }, { event: "pull_request" }, { head_branch: "other" },
      { head_sha: "a".repeat(40) }, { status: "in_progress" }, { id: 456 }]) {
      assert.notEqual(execute(changes).status, 0, JSON.stringify(changes));
    }
    assert.notEqual(execute({}, "../123").status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
