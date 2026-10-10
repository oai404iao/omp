import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { root } from "./workspaces.mjs";
import { verifyPackedCandidate } from "./release-batch.mjs";

const manifest = { name: "@fixture/release-package", version: "1.0.0", private: false, files: ["index.js"] };

function prepareFixture(t, unexpectedFilename) {
  const temporary = mkdtempSync(join(tmpdir(), "omp-prepare-artifacts-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const scripts = join(temporary, "scripts");
  const bin = join(temporary, "bin");
  for (const directory of [scripts, bin, join(temporary, "release-locks"), join(temporary, "fixture")]) {
    mkdirSync(directory);
  }
  for (const file of ["prepare-release-artifacts.mjs", "release-utils.mjs", "release-dependencies.mjs", "recovery-guard.mjs"]) {
    copyFileSync(join(root, "scripts", file), join(scripts, file));
  }
  writeFileSync(join(temporary, ".gitignore"), "release-artifacts/\ncalls.log\n");
  writeFileSync(join(temporary, "fixture/package.json"), JSON.stringify(manifest));
  writeFileSync(join(temporary, "fixture/index.js"), "export const fixture = true;\n");
  writeFileSync(join(temporary, "release-locks/npm-published-artifacts.json"), JSON.stringify({
    schemaVersion: 1, registry: "https://registry.npmjs.org/", releases: {},
  }));
  writeFileSync(join(scripts, "workspaces.mjs"), `
    import { readFileSync } from "node:fs";
    import { resolve } from "node:path";
    export const root = ${JSON.stringify(temporary)};
    export const registry = "https://registry.npmjs.org/";
    export const workspaces = [{ name: ${JSON.stringify(manifest.name)}, directory: "fixture", releaseStatus: "publishable" }];
    export const artifactWorkspaces = () => workspaces;
    export const readManifest = directory => JSON.parse(readFileSync(resolve(root, directory, "package.json"), "utf8"));
  `);
  // Only the registry is mocked in the successful case: git archive and pnpm
  // produce the real immutable release tarball, without any network request.
  writeFileSync(join(bin, "npm"), `#!/bin/sh
printf 'npm %s\\n' "$*" >> "$CALL_LOG"
if [ "$1" = "view" ]; then printf '{"error":{"code":"E404"}}\\n'; exit 1; fi
printf 'Unexpected npm operation\\n' >&2
exit 99
`);
  chmodSync(join(bin, "npm"), 0o755);
  if (unexpectedFilename) {
    writeFileSync(join(bin, "pnpm"), `#!/bin/sh
printf '%s\\n' '${JSON.stringify({ name: manifest.name, version: manifest.version, filename: unexpectedFilename, files: [{ path: "package.json" }] })}'
`);
    chmodSync(join(bin, "pnpm"), 0o755);
  }
  function git(args) {
    const result = spawnSync("git", args, { cwd: temporary, encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  git(["init", "-q"]);
  git(["add", "."]);
  git(["-c", "user.name=Release fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture"]);
  const child = spawnSync(process.execPath, [join(scripts, "prepare-release-artifacts.mjs")], {
    cwd: temporary, encoding: "utf8", timeout: 30000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALL_LOG: join(temporary, "calls.log") },
  });
  const calls = readFileSync(join(temporary, "calls.log"), "utf8").trim().split("\n");
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^npm view @fixture\/release-package@1\.0\.0 /);
  return { temporary, child };
}

test("preparation accepts real pnpm pack object output and records a portable artifact basename", { skip: process.platform === "win32" }, t => {
  const { temporary, child } = prepareFixture(t);
  assert.equal(child.status, 0, child.stdout + child.stderr);
  const output = join(temporary, "release-artifacts");
  const release = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
  assert.equal(release.candidates.length, 1);
  const [candidate] = release.candidates;
  assert.equal(candidate.filename, "fixture-release-package-1.0.0.tgz");
  assert.equal(candidate.filename, basename(candidate.filename));
  assert.equal(candidate.sourceCommit, release.commit);
  assert.equal(candidate.mode, "publish");
  assert.doesNotThrow(() => verifyPackedCandidate(candidate, join(output, candidate.filename), manifest));
  assert.equal(existsSync(join(output, ".staging")), false);
});

test("preparation rejects pnpm output outside the expected artifact directory", { skip: process.platform === "win32" }, t => {
  const { temporary, child } = prepareFixture(t, "../outside.tgz");
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /pnpm pack returned an unexpected artifact path/);
  assert.equal(existsSync(join(temporary, "release-artifacts/manifest.json")), false);
});
