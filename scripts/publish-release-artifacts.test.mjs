import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publishScript = resolve(root, "scripts/publish-release-artifacts.mjs");
const commit = "0123456789012345678901234567890123456789";

function candidate(name) {
  return {
    name,
    version: "1.0.0",
    directory: "example",
    tag: `${name}@1.0.0`,
    mode: "recover",
    sourceCommit: commit,
    distTag: "latest",
    prerelease: false,
    notes: "Example release",
  };
}

function runPublisher(candidates, wrongDistTagFor) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "omp-publish-result-"));
  try {
    const binaryDirectory = join(temporaryDirectory, "bin");
    const manifestPath = join(temporaryDirectory, "manifest.json");
    const resultPath = join(temporaryDirectory, "result.json");
    const callLog = join(temporaryDirectory, "calls.log");
    mkdirSync(binaryDirectory);
    writeFileSync(
      join(binaryDirectory, "git"),
      [
        "#!/bin/sh",
        "printf 'git %s\\n' \"$*\" >> \"$CALL_LOG\"",
        "if [ \"$1\" = \"rev-parse\" ]; then echo \"$FAKE_COMMIT\"; exit 0; fi",
        "if [ \"$1\" = \"rev-list\" ]; then exit 1; fi",
        "exit 0",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(binaryDirectory, "npm"),
      [
        "#!/bin/sh",
        "printf 'npm %s\\n' \"$*\" >> \"$CALL_LOG\"",
        "if [ \"$1\" != \"view\" ]; then exit 1; fi",
        "if [ \"$3\" = \"version\" ]; then",
        "  printf '{\"version\":\"1.0.0\",\"gitHead\":\"%s\"}\\n' \"$FAKE_COMMIT\"",
        "  exit 0",
        "fi",
        "if [ \"$3\" = \"dist-tags\" ]; then",
        "  if [ \"$2\" = \"$WRONG_DIST_TAG_FOR\" ]; then printf '{\"latest\":\"0.9.0\"}\\n'; else printf '{\"latest\":\"1.0.0\"}\\n'; fi",
        "  exit 0",
        "fi",
        "exit 1",
        "",
      ].join("\n"),
    );
    chmodSync(join(binaryDirectory, "git"), 0o755);
    chmodSync(join(binaryDirectory, "npm"), 0o755);
    writeFileSync(
      manifestPath,
      `${JSON.stringify({
        schemaVersion: 1,
        commit,
        registry: "https://registry.npmjs.org/",
        candidates,
      })}\n`,
    );

    const child = spawnSync(process.execPath, [publishScript, manifestPath, resultPath], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binaryDirectory}:${process.env.PATH}`,
        CALL_LOG: callLog,
        FAKE_COMMIT: commit,
        WRONG_DIST_TAG_FOR: wrongDistTagFor ?? "",
      },
    });
    return {
      process: child,
      result: JSON.parse(readFileSync(resultPath, "utf8")),
      calls: readFileSync(callLog, "utf8"),
    };
  } finally {
    // The caller receives all data it needs before this task-owned directory is removed.
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

test("partial reconciliation does not create local tags", { skip: process.platform === "win32" }, () => {
  const first = "@oai404iao/first";
  const second = "@oai404iao/second";
  const { process, result, calls } = runPublisher([candidate(first), candidate(second)], second);

  assert.equal(process.status, 0, process.stderr);
  assert.equal(result.ok, false);
  assert.equal(result.releases.length, 1);
  assert.deepEqual(result.unresolved, [
    `${second}@1.0.0 is not assigned to npm dist-tag latest; fix it interactively`,
  ]);
  assert.doesNotMatch(calls, /^git tag /m);
});

test("clean recovery creates missing tags only after all candidates reconcile", { skip: process.platform === "win32" }, () => {
  const first = "@oai404iao/first";
  const { process, result, calls } = runPublisher([candidate(first)]);

  assert.equal(process.status, 0, process.stderr);
  assert.equal(result.ok, true);
  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(result.publishWarnings, []);
  assert.match(calls, new RegExp(`^git tag ${first.replace("/", "\\/")}@1\\.0\\.0 ${commit}$`, "m"));
});
