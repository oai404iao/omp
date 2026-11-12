import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { dependentChangeset, exactPinEdits, generatedId } from "./workspace-versioning.mjs";
import { root } from "./workspaces.mjs";

const runtimeName = "@fixture/runtime";
const toolsName = "@fixture/capability";
const bundleName = "@fixture/bundle";
const consumerName = "@fixture/optional-consumer";
const unrelatedName = "@fixture/unrelated";

function fixtureManifests() {
  return new Map([
    [runtimeName, { version: "1.0.0" }],
    [toolsName, { version: "2.0.0", dependencies: { [runtimeName]: "1.0.0" } }],
    [bundleName, { version: "3.0.0", dependencies: { [toolsName]: "2.0.0" } }],
    [consumerName, { version: "4.0.0", optionalDependencies: { [bundleName]: "3.0.0" } }],
    [unrelatedName, { version: "5.0.0" }],
  ].map(([name, manifest]) => [name, { name, private: false, ...manifest }]));
}

const graph = new Map([
  ["runtime", { version: "1.0.0" }],
  ["web", { version: "2.0.0", dependencies: { runtime: "1.0.0" } }],
  ["bundle", { version: "3.0.0", dependencies: { web: "2.0.0" } }],
  ["consumer", { version: "4.0.0", optionalDependencies: { bundle: "3.0.0" } }],
]);
test("dependency changes recursively generate explicit consumer changesets, including optional edges", () => {
  const source = [{ id: "source", releases: [{ name: "runtime", type: "patch" }] }];
  const text = dependentChangeset(graph, source);
  for (const name of ["web", "bundle", "consumer"]) assert.ok(text.includes(`"${name}": patch`));
  assert.ok(!text.includes('"runtime": patch'));
  assert.equal(dependentChangeset(graph, [...source, {
    id: generatedId, releases: [{ name: "web", type: "patch" }],
  }]), text);
  assert.equal(dependentChangeset(graph, []), undefined);
  assert.equal(dependentChangeset(graph, [...source, {
    id: "explicit", releases: ["web", "bundle", "consumer"].map(name => ({ name, type: "minor" })),
  }]), undefined);
});

test("pin repair preserves exact dependency and optional dependency versions without unversioned changes", () => {
  const after = structuredClone(graph);
  after.get("runtime").version = "1.0.1";
  assert.throws(() => exactPinEdits(graph, after), /consumer version bump/);
  after.get("web").version = "2.0.1";
  after.get("web").dependencies.runtime = "^1.0.1";
  after.get("bundle").version = "3.0.1";
  after.get("consumer").version = "4.0.1";
  const edited = new Map(exactPinEdits(graph, after));
  assert.equal(edited.get("web").dependencies.runtime, "1.0.1");
  assert.equal(edited.get("consumer").optionalDependencies.bundle, "3.0.1");
  assert.deepEqual(exactPinEdits(graph, graph), []);
});

for (const prerelease of [false, true]) {
test(`real Changesets ${prerelease ? "pre/exit" : "normal"} versioning propagates dependency and transitive optional releases`, async () => {
  const f = await versioningFixture({ privateRuntime: true });
  const { cwd, before, syncDependentChangesets, versionWorkspace, workspaceManifests } = f;
  const pre = command => {
    const result = spawnSync(join(cwd, "node_modules/.bin/changeset"), ["pre", command, ...(command === "enter" ? ["next"] : [])], { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  if (prerelease) pre("enter");
  await assert.rejects(syncDependentChangesets(cwd), /missing or stale/);
  await syncDependentChangesets(cwd, true);
  await assert.doesNotReject(syncDependentChangesets(cwd));
  const generated = readFileSync(join(cwd, ".changeset", `${generatedId}.md`), "utf8");
  for (const name of [toolsName, bundleName, consumerName]) assert.ok(generated.includes(`"${name}": patch`));
  await versionWorkspace(cwd, { updateLock: false });
  const after = workspaceManifests(cwd);
  for (const name of [runtimeName, toolsName, bundleName, consumerName]) {
    assert.notEqual(after.get(name).version, before.get(name).version);
  }
  assert.equal(after.get(consumerName).optionalDependencies[bundleName], after.get(bundleName).version);
  assert.deepEqual(after.get(unrelatedName), before.get(unrelatedName));
  for (const [name, manifest] of after) {
    assert.equal(manifest.private, before.get(name).private, `${name}: versioning must preserve privacy`);
  }
  assert.deepEqual(exactPinEdits(after, after), []);
  await versionWorkspace(cwd, { updateLock: false });
  assert.deepEqual(workspaceManifests(cwd), after);
  if (prerelease) {
    assert.match(after.get(toolsName).version, /-next\./);
    const historyPath = join(cwd, ".changeset/pre", `${generatedId}.md`);
    const history = readFileSync(historyPath, "utf8");
    writeFileSync(join(cwd, ".changeset/capability-next.md"), `---\n"${toolsName}": patch\n---\n\nNext capability fixture.\n`);
    await versionWorkspace(cwd, { updateLock: false });
    const next = workspaceManifests(cwd);
    assert.equal(next.get(runtimeName).version, after.get(runtimeName).version);
    for (const name of [toolsName, bundleName, consumerName]) {
      assert.notEqual(next.get(name).version, after.get(name).version);
    }
    assert.equal(readFileSync(historyPath, "utf8"), history);
    await versionWorkspace(cwd, { updateLock: false });
    assert.deepEqual(workspaceManifests(cwd), next);
    pre("exit");
    await versionWorkspace(cwd, { updateLock: false });
    const stable = workspaceManifests(cwd);
    for (const manifest of stable.values()) assert.doesNotMatch(manifest.version, /-/);
    assert.deepEqual(exactPinEdits(stable, stable), []);
  }
});
}

async function versioningFixture({
  status = "publishable", private: isPrivate = false, locked = {},
  source = runtimeName, prerelease = false, existingChangelog = false, privateRuntime = false,
} = {}) {
  const scratch = join(process.env.HOME, ".local/state/agents/tmp");
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const cwd = mkdtempSync(join(scratch, "omp-workspace-version-"));
  mkdirSync(join(cwd, ".changeset"));
  mkdirSync(join(cwd, "release-locks"));
  mkdirSync(join(cwd, "scripts"));
  writeFileSync(join(cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nimporters: {}\n");
  writeFileSync(join(cwd, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
  writeFileSync(join(cwd, ".changeset/config.json"), JSON.stringify({
    changelog: "@changesets/cli/changelog", commit: false, fixed: [], linked: [],
    access: "public", baseBranch: "main", updateInternalDependencies: "patch",
    privatePackages: { version: true, tag: false }, ignore: [],
  }));
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "fixture", private: true }));
  const before = fixtureManifests();
  before.get(toolsName).private = isPrivate;
  before.get(runtimeName).private = privateRuntime;
  const entries = [...before.keys()].map((name, index) => ({
    name, directory: `packages/package-${index}`,
    releaseStatus: name === toolsName ? status : "publishable",
  }));
  for (const entry of entries) {
    mkdirSync(join(cwd, entry.directory), { recursive: true });
    writeFileSync(join(cwd, entry.directory, "package.json"), JSON.stringify(before.get(entry.name)));
  }
  const changelog = join(cwd, entries.find(entry => entry.name === toolsName).directory, "CHANGELOG.md");
  if (existingChangelog) writeFileSync(changelog,
    `# ${toolsName}\n\n## ${before.get(toolsName).version}\n\nExisting bootstrap notes for ${toolsName}@${before.get(toolsName).version}.\n`);
  const lockPath = join(cwd, "release-locks/npm-published-artifacts.json");
  writeFileSync(lockPath, JSON.stringify({
    schemaVersion: 1, registry: "https://registry.npmjs.org/", releases: locked,
  }));
  writeFileSync(join(cwd, ".changeset/source.md"), `---\n"${source}": patch\n---\n\nBootstrap fixture.\n`);
  if (prerelease) writeFileSync(join(cwd, ".changeset/pre.json"), JSON.stringify({ mode: "pre" }));
  symlinkSync(join(root, "node_modules"), join(cwd, "node_modules"), "dir");
  for (const script of ["workspace-versioning.mjs", "release-dependencies.mjs", "lock-integrity.mjs", "pnpm-lock.mjs"]) {
    writeFileSync(join(cwd, "scripts", script), readFileSync(join(root, "scripts", script)));
  }
  writeFileSync(join(cwd, "scripts/workspaces.mjs"), `
    import { readFileSync } from "node:fs";
    import { join } from "node:path";
    export const root = ${JSON.stringify(cwd)};
    export const registry = "https://registry.npmjs.org/";
    export const workspaces = ${JSON.stringify(entries)};
    export const readManifest = directory => JSON.parse(readFileSync(join(root, directory, "package.json"), "utf8"));
  `);
  writeFileSync(join(cwd, ".gitignore"), "node_modules/\n");
  for (const args of [
    ["init", "-b", "main"], ["add", "."],
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"],
  ]) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  const versioning = await import(pathToFileURL(join(cwd, "scripts/workspace-versioning.mjs")).href);
  return { cwd, before, entries, changelog, lockPath, ...versioning };
}

for (const source of [runtimeName, toolsName]) {
test(`bootstrap preservation of ${source} release keeps the initial version and bumps consumers`, async t => {
  const f = await versioningFixture({ status: "bootstrap", source, existingChangelog: source === runtimeName });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url: String(url), options });
    assert.deepEqual(f.workspaceManifests(f.cwd), f.before, "registry lookup must precede version writes");
    assert.deepEqual(f.exactPinEdits(f.before, f.before), []);
    assert.equal(readFileSync(join(f.cwd, ".changeset/source.md"), "utf8").includes("Bootstrap fixture."), true);
    return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  });
  await f.versionWorkspace(f.cwd, { updateLock: false, preserveBootstrapVersion: toolsName });
  const after = f.workspaceManifests(f.cwd);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://registry.npmjs.org/%40fixture%2Fcapability");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(after.get(toolsName).version, f.before.get(toolsName).version);
  assert.equal(after.get(toolsName).dependencies[runtimeName], after.get(runtimeName).version);
  const consumers = source === runtimeName
    ? [runtimeName, bundleName, consumerName] : [bundleName, consumerName];
  for (const name of consumers) {
    assert.notEqual(after.get(name).version, f.before.get(name).version, `${name}: consumers must still bump`);
  }
  assert.deepEqual(f.exactPinEdits(after, after), []);
  if (source === runtimeName) assert.throws(() => f.exactPinEdits(f.before, after), /consumer version bump/,
      "public pin repair must not acquire an unvalidated exemption");
  assert.deepEqual(after.get(unrelatedName), f.before.get(unrelatedName));
  const changelog = readFileSync(f.changelog, "utf8");
  assert.equal(changelog.split(`## ${after.get(toolsName).version}\n`).length, 2);
  if (source === runtimeName) {
    assert.ok(changelog.includes(`Existing bootstrap notes for ${toolsName}@${after.get(toolsName).version}.`));
    assert.match(changelog, /Updated dependencies/);
  } else {
    assert.match(changelog, /Bootstrap fixture/);
    assert.equal(after.get(runtimeName).version, f.before.get(runtimeName).version);
  }
  const bundleLog = readFileSync(join(f.cwd, f.entries.find(entry => entry.name === bundleName).directory, "CHANGELOG.md"), "utf8");
  assert.ok(bundleLog.includes(`${toolsName}@${after.get(toolsName).version}`));
});
}

for (const failure of [
  "published", "locked", "historically-locked", "blocked", "private", "unrelated-name",
  "unrelated-release", "registry-error", "ambiguous-404", "network-error", "prerelease", "malformed-lock",
]) {
  test(`bootstrap preservation rejects ${failure} before writing anything`, async t => {
    const key = `${toolsName}@${fixtureManifests().get(toolsName).version}`;
    const f = await versioningFixture({
      status: failure === "blocked" ? "blocked" : "bootstrap",
      private: failure === "private",
      locked: failure === "locked" ? { [key]: {} }
        : failure === "historically-locked" ? { [`${toolsName}@0.0.1`]: {} } : {},
      source: failure === "unrelated-release" ? unrelatedName : runtimeName,
      prerelease: failure === "prerelease",
    });
    if (failure === "malformed-lock") writeFileSync(f.lockPath, "{}");
    const snapshot = () => JSON.stringify([
      [...f.workspaceManifests(f.cwd)],
      f.entries.map(entry => readdirSync(join(f.cwd, entry.directory))
        .filter(name => name.endsWith(".md")).map(name =>
          [entry.name, name, readFileSync(join(f.cwd, entry.directory, name), "utf8")])),
      readFileSync(f.lockPath, "utf8"),
      readFileSync(join(f.cwd, "pnpm-lock.yaml"), "utf8"),
      readdirSync(join(f.cwd, ".changeset")).map(name => [name, readFileSync(join(f.cwd, ".changeset", name), "utf8")]),
    ]);
    const before = snapshot();
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      if (failure === "network-error") throw new Error("network fixture error");
      if (failure === "published") return new Response("{}", { status: 200 });
      if (failure === "registry-error") return new Response("{}", { status: 503 });
      return new Response(JSON.stringify({ error: "ambiguous" }), { status: 404 });
    });
    await assert.rejects(f.versionWorkspace(f.cwd, {
      updateLock: false,
      preserveBootstrapVersion: failure === "unrelated-name" ? runtimeName : toolsName,
    }));
    assert.equal(snapshot(), before, "rejected preservation must leave all release metadata untouched");
    assert.equal(calls, ["published", "registry-error", "ambiguous-404", "network-error"].includes(failure) ? 1 : 0);
  });
}

test("bootstrap preservation CLI rejects incomplete, repeated and non-version flags", () => {
  for (const args of [
    ["version", "--preserve-bootstrap-version"],
    ["version", "--preserve-bootstrap-version", toolsName, "--preserve-bootstrap-version", toolsName],
    ["sync", "--preserve-bootstrap-version", toolsName],
    ["check", "--preserve-bootstrap-version", toolsName],
    ["version", "--unknown", toolsName],
  ]) {
    const result = spawnSync(process.execPath, [join(root, "scripts/workspace-versioning.mjs"), ...args], {
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /usage:/);
  }
});
