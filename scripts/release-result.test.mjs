import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
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

test("incomplete finalization invokes neither git nor gh", { skip: process.platform === "win32" }, () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "omp-release-result-"));
  try {
    const binaryDirectory = join(temporaryDirectory, "bin");
    const resultPath = join(temporaryDirectory, "result.json");
    const callLog = join(temporaryDirectory, "calls.log");

    mkdirSync(binaryDirectory);
    writeFileSync(
      join(binaryDirectory, "git"),
      "#!/bin/sh\nprintf 'git %s\\n' \"$*\" >> \"$CALL_LOG\"\n",
    );
    writeFileSync(
      join(binaryDirectory, "gh"),
      "#!/bin/sh\nprintf 'gh %s\\n' \"$*\" >> \"$CALL_LOG\"\nexit 0\n",
    );
    chmodSync(join(binaryDirectory, "git"), 0o755);
    chmodSync(join(binaryDirectory, "gh"), 0o755);
    writeFileSync(
      resultPath,
      `${JSON.stringify(
        readyResult({
          ok: false,
          unresolved: ["@oai404iao/example@1.0.0 is not published"],
        }),
      )}\n`,
    );

    const result = spawnSync(process.execPath, [finalizeScript, resultPath], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binaryDirectory}:${process.env.PATH}`,
        CALL_LOG: callLog,
      },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /tags and GitHub Releases were not finalized/);
    assert.equal(existsSync(callLog), false);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("ready finalization atomically pushes tags before creating a release", { skip: process.platform === "win32" }, () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "omp-release-result-"));
  try {
    const binaryDirectory = join(temporaryDirectory, "bin");
    const resultPath = join(temporaryDirectory, "result.json");
    const callLog = join(temporaryDirectory, "calls.log");

    mkdirSync(binaryDirectory);
    writeFileSync(
      join(binaryDirectory, "git"),
      "#!/bin/sh\nprintf 'git %s\\n' \"$*\" >> \"$CALL_LOG\"\n",
    );
    writeFileSync(
      join(binaryDirectory, "gh"),
      [
        "#!/bin/sh",
        "printf 'gh %s\\n' \"$*\" >> \"$CALL_LOG\"",
        "if [ \"$1\" = \"release\" ] && [ \"$2\" = \"view\" ]; then exit 1; fi",
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(join(binaryDirectory, "git"), 0o755);
    chmodSync(join(binaryDirectory, "gh"), 0o755);
    writeFileSync(resultPath, `${JSON.stringify(readyResult())}\n`);

    const result = spawnSync(process.execPath, [finalizeScript, resultPath], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binaryDirectory}:${process.env.PATH}`,
        CALL_LOG: callLog,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(callLog, "utf8");
    assert.match(calls, /git push --atomic origin @oai404iao\/example@1\.0\.0/);
    assert.match(calls, /gh release view @oai404iao\/example@1\.0\.0/);
    assert.match(calls, /gh release create @oai404iao\/example@1\.0\.0/);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
