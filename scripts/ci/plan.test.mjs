import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readPackage, testPackages } from "./catalog.mjs";
import { affectedPlan, createPlan, githubOutputs, parseDiff, parsePlanArgs,
  tasksForPlan, validatePlan } from "./plan.mjs";

const sha = "a".repeat(40);
const scratch = join(homedir(), ".local/state/agents/tmp");
function fixture() {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "omp-ci-planner-"));
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-q");
  git("config", "user.email", "ci-fixture@example.invalid");
  git("config", "user.name", "CI fixture");
  for (const entry of testPackages) {
    mkdirSync(join(root, entry.directory), { recursive: true });
    writeFileSync(join(root, entry.directory, "package.json"), JSON.stringify(readPackage(entry)));
  }
  const write = (path, content = "fixture") => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const commit = () => { git("add", "."); git("commit", "-qm", "fixture"); return git("rev-parse", "HEAD"); };
  return { root, git, write, commit, base: commit() };
}

test("full plan contains nine package checks, all suites, and policy in stable order", () => {
  const value = createPlan({ git: () => `${sha}\n` });
  assert.equal(value.packages.length, 9);
  assert.deepEqual(value.suites, ["composition", "consumers", "infrastructure"]);
  assert.equal(tasksForPlan(value).length, 13);
  assert.equal(tasksForPlan(value)[0].id, "policy");
  assert.deepEqual(value.packages, [...value.packages].sort());
  const outputs = githubOutputs(value);
  assert.match(outputs, /has_packages=true\nhas_suites=true\nfull=true/);
  assert.ok(outputs.includes(`plan=${JSON.stringify(value)}\n`));
});

test("documentation remains policy-only but unknown/shared/toolchain paths fall back full", () => {
  for (const path of ["README.md", "docs/audit.md", ".changeset/example.md"]) {
    const value = affectedPlan([path], [], sha);
    assert.deepEqual(tasksForPlan(value).map(entry => entry.id), ["policy"]);
  }
  for (const path of ["unknown", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml",
    ".github/workflows/ci.yml", "scripts/ci/plan.mjs", "tsconfig.json", "docs/config.json",
    "pi-extensions/new-package/index.ts"]) {
    const value = affectedPlan([path], [], sha);
    assert.equal(value.full, true, path);
    assert.match(value.reasons[0], /Full fallback/);
  }
  assert.equal(tasksForPlan(affectedPlan([], [], sha)).length, 1);
});

test("subagent and all Codex packages activate integrations; local notify is testable alone", () => {
  for (const entry of testPackages.filter(entry => entry.id.startsWith("pi-codex-") || entry.id === "pi-subagent")) {
    assert.deepEqual(affectedPlan([`${entry.directory}/index.ts`], [], sha).suites, ["composition", "consumers"]);
  }
  const local = affectedPlan(["pi-extensions/pi-local-notify/index.ts"], [], sha);
  assert.deepEqual(local.packages, ["pi-local-notify"]);
  assert.deepEqual(local.suites, []);
  assert.deepEqual(affectedPlan(["tests/codex/fixture.json"], [], sha).suites, ["composition", "consumers"]);
});

test("NUL diff handles deletes, renames and copies without path splitting", () => {
  assert.deepEqual(parseDiff("D\0old path\0R100\0before\0after\0C80\0from\0to\0"),
    ["after", "before", "from", "old path", "to"]);
  assert.throws(() => parseDiff("R100\0before\0"), /diff/);
});

test("affected planning uses merge-base, rename endpoints, deleted paths, and base graph edges", () => {
  const repo = fixture();
  const local = testPackages.find(entry => entry.id === "pi-local-notify");
  const telegram = testPackages.find(entry => entry.id === "pi-telegram-notify");
  const manifest = readPackage(local);
  manifest.optionalDependencies = { [telegram.name]: "1.0.0" };
  repo.write(`${local.directory}/package.json`, JSON.stringify(manifest));
  repo.write(`${telegram.directory}/old file.ts`);
  const base = repo.commit();
  delete manifest.optionalDependencies;
  repo.write(`${local.directory}/package.json`, JSON.stringify(manifest));
  repo.git("mv", `${telegram.directory}/old file.ts`, `${local.directory}/renamed file.ts`);
  const head = repo.commit();
  const value = createPlan({ mode: "affected", base, head, root: repo.root });
  assert.equal(value.full, false);
  assert.deepEqual(value.packages, ["pi-local-notify", "pi-telegram-notify"]);
  assert.equal(value.sourceSha, head);
  repo.git("rm", `${local.directory}/renamed file.ts`);
  const deletion = repo.commit();
  assert.deepEqual(createPlan({ mode: "affected", base: head, head: deletion, root: repo.root }).packages, ["pi-local-notify"]);
  // A dirty working tree does not change the immutable revision plan.
  repo.write("unknown-file", "unstaged");
  assert.deepEqual(createPlan({ mode: "affected", base: head, head: deletion, root: repo.root }).packages, ["pi-local-notify"]);
});

test("missing revisions/diff/graph safely fall back, but invalid registrations fail", () => {
  const repo = fixture();
  assert.equal(createPlan({ mode: "affected", base: "missing", root: repo.root }).full, true);
  assert.equal(createPlan({ mode: "affected", base: repo.base, head: "missing", root: repo.root }).sourceSha, "unknown");
  repo.git("rm", "pi-extensions/pi-local-notify/package.json");
  const missingManifestHead = repo.commit();
  // Current checkout registration must remain valid even when an explicit historic head is incomplete.
  repo.write("pi-extensions/pi-local-notify/package.json", JSON.stringify(readPackage(testPackages.find(entry => entry.id === "pi-local-notify"))));
  assert.equal(createPlan({ mode: "affected", base: repo.base, head: missingManifestHead, root: repo.root }).full, true);
  const broken = fixture();
  broken.write("pi-extensions/pi-local-notify/package.json", JSON.stringify({ name: "wrong", scripts: { check: "check" } }));
  assert.throws(() => createPlan({ mode: "affected", base: broken.base, head: broken.commit(), root: broken.root }), /registration/);
  let calls = 0;
  const value = createPlan({ mode: "affected", base: repo.base, git: args => {
    calls++;
    if (args[0] === "diff") return "invalid diff";
    return sha;
  } });
  assert.equal(value.full, true);
  assert.ok(calls >= 4);
});

test("every planning mode fails before fallback if the current checkout has an unregistered package", () => {
  const repo = fixture();
  repo.write("pi-extensions/new-plugin/package.json", JSON.stringify({ name: "new-plugin", scripts: { check: "check" } }));
  for (const mode of ["full", "affected", "release"]) {
    assert.throws(() => createPlan({ mode, base: "missing", head: "missing", root: repo.root }), /unregistered: pi-extensions\/new-plugin/);
  }
});

test("release plans use canonical runtime/optional closure, never local notify", () => {
  const value = createPlan({ mode: "release", packageName: "@oai404iao/pi-codex-tools", git: () => sha });
  assert.deepEqual(value.packages, ["pi-codex-runtime", "pi-codex-tools"]);
  assert.deepEqual(value.suites, ["composition", "consumers", "infrastructure"]);
  const notify = createPlan({ mode: "release", packageName: "@oai404iao/pi-telegram-notify", git: () => sha });
  assert.deepEqual(notify.suites, ["infrastructure"]);
  assert.equal(createPlan({ mode: "release", packageName: "", git: () => sha }).packages.length, 8);
  assert.throws(() => createPlan({ mode: "release", packageName: "@oai404iao/pi-local-notify", git: () => sha }), /Unapproved/);
});

test("CLI and plan validation reject conflicting/invalid/under-scoped input", () => {
  assert.equal(parsePlanArgs(["--base", sha, "--head", "HEAD", "--shadow"]).mode, "affected");
  assert.equal(parsePlanArgs(["--package", ""]).mode, "release");
  assert.deepEqual(parsePlanArgs(["--release"]), { mode: "release" });
  assert.deepEqual(parsePlanArgs(["--release", "--package", "named"]), { mode: "release", packageName: "named" });
  assert.deepEqual(parsePlanArgs(["--package", "named", "--release"]), { mode: "release", packageName: "named" });
  for (const args of [["--full", "--base", sha], ["--base"], ["--wat"], ["--full", "--package", "x"],
    ["--release", "--full"], ["--full", "--release"], ["--release", "--base", sha],
    ["--base", sha, "--release"], ["--release", "--release"]]) {
    assert.throws(() => parsePlanArgs(args));
  }
  const value = createPlan({ git: () => sha });
  assert.throws(() => validatePlan({ ...value, packages: [] }), /full/);
  assert.throws(() => validatePlan({ ...value, full: false, mode: "affected", packages: ["unknown"] }), /packages/);
  assert.throws(() => validatePlan({ ...value, full: false, mode: "affected", suites: [] }), /integration/);
  assert.throws(() => validatePlan({ ...value, policy: false }), /metadata/);
  assert.throws(() => validatePlan({ ...value, mode: "release" }), /release/);
});
