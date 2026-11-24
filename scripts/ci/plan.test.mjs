import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readPackage, testPackages } from "./catalog.mjs";
import { resolveReleaseWorkspaces } from "../release-resolution.mjs";
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

test("ordinary CI can plan from a clean checkout without installing release tooling", () => {
  const repo = fixture();
  for (const path of ["scripts", "release-locks", "package.json"]) {
    cpSync(new URL(`../../${path}`, import.meta.url), join(repo.root, path), { recursive: true });
  }
  const result = spawnSync(process.execPath, ["scripts/ci/plan.mjs", "--full"], { cwd: repo.root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).sourceSha, repo.base);
});

test("documentation remains policy-only but unknown/shared/toolchain paths fall back full", () => {
  for (const path of ["README.md", "docs/audit.md", ".changeset/example.md"]) {
    const value = affectedPlan([path], [], sha);
    assert.deepEqual(tasksForPlan(value).map(entry => entry.id), ["policy"]);
  }
  for (const path of ["unknown", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml",
    "scripts/workspaces.mjs", ".github/actions/setup-ci/action.yml", "tsconfig.json", "docs/config.json",
    "pi-extensions/new-package/index.ts"]) {
    const value = affectedPlan([path], [], sha);
    assert.equal(value.full, true, path);
    assert.match(value.reasons[0], /Full fallback/);
  }
  assert.equal(tasksForPlan(affectedPlan([], [], sha)).length, 1);
});

test("infrastructure changes do not select package or consumer checks without a shared dependency", () => {
  for (const path of ["scripts/ci/plan.mjs", "scripts/release-utils.mjs", "scripts/verify-packages.test.mjs",
    ".github/workflows/ci.yml", ".github/dependabot.yml"]) {
    const value = affectedPlan([path, "CONTRIBUTING.md"], [], sha);
    assert.equal(value.full, false, path);
    assert.deepEqual(value.packages, [], path);
    assert.deepEqual(value.suites, ["infrastructure"], path);
  }
});

test("behavioral script dependencies select their suites and mixed changes preserve all work", () => {
  assert.deepEqual(affectedPlan(["scripts/workspace-ranges.mjs"], [], sha).suites, ["composition", "consumers", "infrastructure"]);
  for (const path of ["scripts/test-codex-composition.mjs", "scripts/check-codex-architecture.mjs"]) {
    assert.deepEqual(affectedPlan([path], [], sha).suites, ["composition", "infrastructure"]);
  }
  for (const path of ["scripts/verify-codex-installations.mjs", "scripts/codex-consumer-matrix.mjs",
    "scripts/codex-loader-probe.mjs", "scripts/subagent-consumer-probe.mjs",
    "scripts/isolated-consumer-lock.mjs", "scripts/pnpm-lock.mjs", "scripts/pi-version.mjs"]) {
    assert.deepEqual(affectedPlan([path], [], sha).suites, ["consumers", "infrastructure"], path);
  }
  const paths = ["scripts/ci/plan.mjs", "pi-extensions/pi-notify/index.ts"];
  const mixed = affectedPlan(paths, [], sha);
  assert.deepEqual(mixed.packages, ["pi-notify"]);
  assert.deepEqual(mixed.suites, ["infrastructure"]);
  assert.deepEqual(affectedPlan([...paths, "tests/codex/fixture.json"], [], sha).suites,
    ["composition", "consumers", "infrastructure"]);
  assert.equal(affectedPlan([...paths, "unknown"], [], sha).full, true);
  assert.equal(affectedPlan([...paths, "pnpm-lock.yaml"], [], sha).full, true);
});

test("subagent and all Codex packages activate integrations; notify is testable alone", () => {
  for (const entry of testPackages.filter(entry => entry.id.startsWith("pi-codex-") || entry.id === "pi-subagent")) {
    assert.deepEqual(affectedPlan([`${entry.directory}/index.ts`], [], sha).suites, ["composition", "consumers"]);
  }
  const local = affectedPlan(["pi-extensions/pi-notify/index.ts"], [], sha);
  assert.deepEqual(local.packages, ["pi-notify"]);
  assert.deepEqual(local.suites, []);
  assert.deepEqual(affectedPlan(["tests/codex/fixture.json"], [], sha).suites, ["composition", "consumers"]);
});

test("NUL diff handles deletes, renames and copies without path splitting", () => {
  assert.deepEqual(parseDiff("D\0old path\0R100\0before\0after\0C80\0from\0to\0"),
    ["after", "before", "from", "old path", "to"]);
  assert.throws(() => parseDiff("R100\0before\0"), /diff/);
});

test("affected planning uses merge-base, rename endpoints, and deleted paths", () => {
  const repo = fixture();
  const before = "pi-extensions/pi-codex-web-search/old file.ts";
  const after = "pi-extensions/pi-notify/renamed file.ts";
  repo.write(before);
  const mergeBase = repo.commit();
  repo.write("pi-extensions/pi-codex-imagegen/base-only.ts");
  const base = repo.commit();
  repo.git("switch", "--detach", mergeBase);
  repo.git("mv", before, after);
  const head = repo.commit();
  const value = createPlan({ mode: "affected", base, head, root: repo.root });
  assert.equal(value.full, false);
  assert.deepEqual(value.packages, ["pi-codex-web-search", "pi-notify"]);
  assert.equal(value.sourceSha, head);
  repo.git("rm", after);
  const deletion = repo.commit();
  assert.deepEqual(createPlan({ mode: "affected", base: head, head: deletion, root: repo.root }).packages, ["pi-notify"]);
  // A dirty working tree does not change the immutable revision plan.
  repo.write("unknown-file", "unstaged");
  assert.deepEqual(createPlan({ mode: "affected", base: head, head: deletion, root: repo.root }).packages, ["pi-notify"]);
});

test("affected planning includes consumers linked only in the base graph", () => {
  const paths = ["pi-extensions/pi-codex-web-search/index.ts"];
  const base = new Map([["pi-notify", new Set(["pi-codex-web-search"])]]);
  const head = new Map();
  assert.deepEqual(affectedPlan(paths, [head], sha).packages, ["pi-codex-web-search"]);
  assert.deepEqual(affectedPlan(paths, [base, head], sha).packages, ["pi-codex-web-search", "pi-notify"]);
});

test("a workspace privacy change compares each manifest only with a compatible catalog and runs full CI", () => {
  const repo = fixture();
  const entry = testPackages.find(entry => entry.id === "pi-rsi");
  const manifest = readPackage(entry);
  const path = `${entry.directory}/package.json`;
  repo.write(path, JSON.stringify({ ...manifest, private: true }));
  repo.write("scripts/workspaces.mjs", "// private workspace catalog");
  const base = repo.commit();
  repo.write(path, JSON.stringify(manifest));
  repo.write("scripts/workspaces.mjs", "// bootstrap workspace catalog");
  const head = repo.commit();
  const plan = createPlan({ mode: "affected", base, head, root: repo.root });
  assert.equal(plan.full, true);
  assert.deepEqual(tasksForPlan(plan), tasksForPlan(createPlan({ mode: "full", head, root: repo.root })));

  // A valid working tree must not conceal an invalid manifest in the requested head revision.
  repo.write(path, JSON.stringify({ ...manifest, private: true }));
  const invalidHead = repo.commit();
  repo.write(path, JSON.stringify(manifest));
  assert.throws(() => createPlan({ mode: "affected", base, head: invalidHead, root: repo.root }), /registration/);
});

test("missing revisions/diff/graph safely fall back, but invalid registrations fail", () => {
  const repo = fixture();
  assert.equal(createPlan({ mode: "affected", base: "missing", root: repo.root }).full, true);
  assert.equal(createPlan({ mode: "affected", base: repo.base, head: "missing", root: repo.root }).sourceSha, "unknown");
  repo.git("rm", "pi-extensions/pi-notify/package.json");
  const missingManifestHead = repo.commit();
  // Current checkout registration must remain valid even when an explicit historic head is incomplete.
  repo.write("pi-extensions/pi-notify/package.json", JSON.stringify(readPackage(testPackages.find(entry => entry.id === "pi-notify"))));
  assert.equal(createPlan({ mode: "affected", base: repo.base, head: missingManifestHead, root: repo.root }).full, true);
  const broken = fixture();
  broken.write("pi-extensions/pi-notify/package.json", JSON.stringify({ name: "wrong", scripts: { check: "check" } }));
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

test("release source plans cover dependencies and consumers of the targets, not unrelated extensions", () => {
  const value = createPlan({ mode: "release", packageName: "@oai404iao/pi-codex-tools", git: () => sha });
  const toolsChecks = ["pi-codex-imagegen", "pi-codex-minimal-tools", "pi-codex-runtime", "pi-codex-tools", "pi-codex-web-search"];
  assert.deepEqual(value.packages, toolsChecks);
  assert.deepEqual(value.suites, ["composition", "consumers", "infrastructure"]);
  for (const id of ["pi-notify", "pi-rsi"]) {
    const standalone = createPlan({ mode: "release", packageName: `@oai404iao/${id}`, git: () => sha });
    assert.deepEqual(standalone.packages, [id]);
    assert.deepEqual(standalone.suites, ["infrastructure"]);
  }
  const batch = createPlan({ mode: "release", packageName: "@oai404iao/pi-notify,@oai404iao/pi-codex-tools", git: () => sha });
  assert.deepEqual(batch.packages, [...toolsChecks, "pi-notify"]);
  assert.deepEqual(batch.suites, ["composition", "consumers", "infrastructure"]);
  assert.equal(createPlan({ mode: "release", git: () => sha }).packages.length, 9);
  assert.throws(() => createPlan({ mode: "release", packageName: "", git: () => sha }), /Select at least one/);
  for (const id of ["pi-telegram-notify", "unapproved"]) {
    assert.throws(() => createPlan({ mode: "release", packageName: `@oai404iao/${id}`, git: () => sha }), /Unapproved/);
  }
});

test("source planning follows workspace names while artifacts select a supported registry major", () => {
  const repo = fixture();
  const provider = testPackages.find(e => e.id === "pi-codex-runtime");
  const consumer = testPackages.find(e => e.id === "pi-subagent");
  function write(entry, fields) {
    repo.write(`${entry.directory}/package.json`, JSON.stringify({ ...readPackage(entry, repo.root), ...fields }));
  }
  write(provider, { version: "3.1.0" });
  const publishedSha = repo.commit();
  write(provider, { version: "4.0.0" });
  write(consumer, { optionalDependencies: { [provider.name]: "^3.0.0" } });
  const head = repo.commit();
  const source = createPlan({ mode: "release", packageName: consumer.name, root: repo.root });
  assert.equal(source.sourceSha, head);
  assert.deepEqual(source.packages, [provider.id, consumer.id]);
  const artifacts = resolveReleaseWorkspaces([consumer.name], head, { checkout: entry => readPackage(entry, repo.root),
    versions: () => ["3.1.0", "4.0.0"],
    lookup: (name, version) => {
      assert.deepEqual([name, version], [provider.name, "3.1.0"]);
      return { exists: true, gitHead: publishedSha, integrity: "sha512-fixture" };
    },
    check: candidate => JSON.parse(repo.git("show", `${candidate.sourceCommit}:${candidate.directory}/package.json`)),
  });
  assert.deepEqual(artifacts.map(({ manifest }) => [manifest.name, manifest.version]), [
    [provider.name, "3.1.0"], [consumer.name, readPackage(consumer, repo.root).version],
  ]);
  write(provider, { dependencies: { [consumer.name]: "^1.0.0" } });
  assert.throws(() => createPlan({ mode: "release", packageName: consumer.name, root: repo.root }), /cycle/);
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
