import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { isWorkspaceRange, satisfiesWorkspaceDependency } from "./workspace-ranges.mjs";
import { staleWorkspaceResolutions } from "./workspace-versioning.mjs";
import { root } from "./workspaces.mjs";

const runtimeName = "@fixture/runtime";
const toolsName = "@fixture/capability";
const bundleName = "@fixture/bundle";
const consumerName = "@fixture/optional-consumer";
const unrelatedName = "@fixture/unrelated";

function fixtureManifests() {
  return new Map([
    [runtimeName, { version: "1.0.0" }],
    [toolsName, { version: "2.0.0", dependencies: { [runtimeName]: "^1.0.0" } }],
    [bundleName, { version: "3.0.0", dependencies: { [toolsName]: "^2.0.0" } }],
    [consumerName, { version: "4.0.0", optionalDependencies: { [bundleName]: "^3.0.0" } }],
    [unrelatedName, { version: "5.0.0" }],
  ].map(([name, manifest]) => [name, { name, private: false, ...manifest }]));
}

test("numeric caret compatibility excludes incompatible majors, 0.x minors, and implicit prereleases", () => {
  for (const bad of ["workspace:^", "^1", "^1.0", "^v1.2.3", "~1.0.0", "*", ">=1.0.0", null]) {
    assert.equal(isWorkspaceRange(bad), false);
    assert.equal(satisfiesWorkspaceDependency("1.2.3", bad), false);
  }
  assert.equal(satisfiesWorkspaceDependency("0.2.3", "^0.2.2"), true);
  assert.equal(satisfiesWorkspaceDependency("0.3.0", "^0.2.2"), false);
  assert.equal(satisfiesWorkspaceDependency("4.0.0", "^3.1.2"), false);
  assert.equal(satisfiesWorkspaceDependency("3.1.1", "^3.1.2"), false);
  assert.equal(satisfiesWorkspaceDependency("3.1.3-next.0", "^3.1.2"), false);
  assert.equal(satisfiesWorkspaceDependency("3.1.3-next.0", "3.1.3-next.0"), true);
});

for (const source of [runtimeName, toolsName]) {
  test(`real Changesets bumps only ${source}, without manifest/changelog writes to consumers`, async t => {
    const f = await versioningFixture(t, { source });
    await f.versionWorkspace(f.cwd, { updateLock: false });
    const after = f.workspaceManifests(f.cwd);
    const expected = structuredClone(f.before);
    expected.get(source).version = source === runtimeName ? "1.0.1" : "2.0.1";
    assert.deepEqual(after, expected);
    for (const { name, directory } of f.entries) {
      assert.equal(readdirSync(join(f.cwd, directory)).includes("CHANGELOG.md"), name === source);
    }
    await f.versionWorkspace(f.cwd, { updateLock: false });
    assert.deepEqual(f.workspaceManifests(f.cwd), after);
  });
}

test("a provider major versions independently while consumers remain on the old compatible line", async t => {
  const f = await versioningFixture(t);
  const source = join(f.cwd, ".changeset/source.md");
  const major = `---\n"${runtimeName}": major\n---\n\nBreaking fixture.\n`;
  writeFileSync(source, major);
  await f.versionWorkspace(f.cwd, { updateLock: false });
  const expected = structuredClone(f.before);
  expected.get(runtimeName).version = "2.0.0";
  assert.deepEqual(f.workspaceManifests(f.cwd), expected);
  await f.checkWorkspace(f.cwd);
});

test("a frozen workspace link must revert to a locked registry archive when the provider moves out of range", () => {
  const manifests = new Map([["core", { dependencies: { runtime: "^3.1.2" } }], ["runtime", { version: "3.1.3" }]]);
  const entries = [...manifests.keys()].map(name => ({ name, directory: `packages/${name}` }));
  const ref = { specifier: "^3.1.2", version: "link:../runtime" };
  const lock = { importers: { "packages/core": { dependencies: { runtime: ref } } }, packages: {}, snapshots: {} };
  assert.deepEqual(staleWorkspaceResolutions(lock, manifests, entries), []);
  manifests.get("runtime").version = "4.0.0";
  const stale = [{ directory: "packages/core", field: "dependencies", dep: "runtime" }];
  assert.deepEqual(staleWorkspaceResolutions(lock, manifests, entries), stale);
  ref.version = "3.1.3";
  assert.deepEqual(staleWorkspaceResolutions(lock, manifests, entries), stale);
  lock.packages["runtime@3.1.3"] = { resolution: { integrity: "sha512-reviewed", tarball: "file:some-path" } };
  lock.snapshots["runtime@3.1.3"] = {};
  assert.deepEqual(staleWorkspaceResolutions(lock, manifests, entries), stale);
  lock.packages["runtime@3.1.3"].resolution.tarball = "https://registry.npmjs.org/runtime/-/runtime-3.1.3.tgz";
  assert.deepEqual(staleWorkspaceResolutions(lock, manifests, entries), []);
});

test("the coordinated migration introduces only first-compatible stable floors, once", async t => {
  const f = await versioningFixture(t);
  const plan = {};
  const patches = [runtimeName, toolsName, bundleName, consumerName];
  for (const [index, consumer] of patches.entries()) {
    if (!index) continue;
    const dep = patches[index - 1];
    const file = join(f.cwd, f.entries.find(e => e.name === consumer).directory, "package.json");
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    (manifest.dependencies ?? manifest.optionalDependencies)[dep] = f.before.get(dep).version;
    writeFileSync(file, JSON.stringify(manifest));
    plan[consumer] = { [dep]: `^${index}.0.1` };
  }
  const file = join(f.cwd, ".changeset/codex-compatibility-floors.json");
  writeFileSync(file, JSON.stringify(plan));
  const old = f.workspaceManifests(f.cwd);
  await assert.rejects(f.versionWorkspace(f.cwd, { updateLock: false }), /explicit patch release/);
  assert.deepEqual(f.workspaceManifests(f.cwd), old);
  writeFileSync(join(f.cwd, ".changeset/source.md"), `---\n${patches.map(n => `"${n}": patch`).join("\n")}\n---\n\nMigration.\n`);
  const expected = structuredClone(old);
  for (const [i, name] of patches.entries()) {
    const m = expected.get(name);
    m.version = `${i + 1}.0.1`;
    if (i) Object.assign(m.dependencies ?? m.optionalDependencies, plan[name]);
  }
  await f.versionWorkspace(f.cwd, { updateLock: false });
  assert.deepEqual(f.workspaceManifests(f.cwd), expected);
  assert.equal(existsSync(file), false);
  await f.checkWorkspace(f.cwd);
});

test("prerelease iterations and stable exit do not consume changes twice or bump consumers", async t => {
  const f = await versioningFixture(t, { source: runtimeName });
  const pre = command => {
    const result = spawnSync(join(f.cwd, "node_modules/.bin/changeset"), ["pre", command, ...(command === "enter" ? ["next"] : [])], { cwd: f.cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  pre("enter");
  const expected = structuredClone(f.before);
  for (const version of ["1.0.1-next.0", "1.0.1-next.1", "1.0.1"]) {
    if (version.endsWith("next.1")) writeFileSync(join(f.cwd, ".changeset/another.md"), `---\n"${runtimeName}": patch\n---\n\nNext fixture.\n`);
    if (!version.includes("next")) pre("exit");
    await f.versionWorkspace(f.cwd, { updateLock: false });
    expected.get(runtimeName).version = version;
    assert.deepEqual(f.workspaceManifests(f.cwd), expected);
    await f.versionWorkspace(f.cwd, { updateLock: false });
    assert.deepEqual(f.workspaceManifests(f.cwd), expected);
  }
});

async function versioningFixture(t, {
  status = "publishable", private: isPrivate = false, locked = {},
  source = runtimeName, prerelease = false, existingChangelog = false,
} = {}) {
  const scratch = join(process.env.HOME, ".local/state/agents/tmp");
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const cwd = mkdtempSync(join(scratch, "omp-workspace-version-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, ".changeset"));
  mkdirSync(join(cwd, "release-locks"));
  mkdirSync(join(cwd, "scripts"));
  writeFileSync(join(cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nimporters: {}\n");
  writeFileSync(join(cwd, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
  writeFileSync(join(cwd, ".changeset/config.json"), readFileSync(join(root, ".changeset/config.json")));
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "fixture", private: true }));
  const before = fixtureManifests();
  before.get(toolsName).private = isPrivate;
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
  for (const script of ["workspace-versioning.mjs", "workspace-ranges.mjs", "release-dependencies.mjs", "lock-integrity.mjs", "pnpm-lock.mjs"]) {
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

test("bootstrap preservation requires its own explicit changeset and leaves compatible consumers untouched", async t => {
  const f = await versioningFixture(t, { status: "bootstrap", source: toolsName, existingChangelog: true });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url: String(url), options });
    assert.deepEqual(f.workspaceManifests(f.cwd), f.before, "registry lookup must precede version writes");
    assert.equal(readFileSync(join(f.cwd, ".changeset/source.md"), "utf8").includes("Bootstrap fixture."), true);
    return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  });
  await f.versionWorkspace(f.cwd, { updateLock: false, preserveBootstrapVersion: toolsName });
  assert.deepEqual(f.workspaceManifests(f.cwd), f.before);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://registry.npmjs.org/%40fixture%2Fcapability");
  assert.equal(calls[0].options.redirect, "error");
  const changelog = readFileSync(f.changelog, "utf8");
  assert.equal(changelog.split("## 2.0.0\n").length, 2);
  assert.match(changelog, /Bootstrap fixture/);
  assert.match(changelog, /Existing bootstrap notes/);
});

for (const failure of [
  "published", "locked", "historically-locked", "blocked", "private", "unrelated-name",
  "unrelated-release", "registry-error", "ambiguous-404", "network-error", "prerelease", "malformed-lock",
]) {
  test(`bootstrap preservation rejects ${failure} before writing anything`, async t => {
    const key = `${toolsName}@${fixtureManifests().get(toolsName).version}`;
    const f = await versioningFixture(t, {
      status: failure === "blocked" ? "blocked" : "bootstrap",
      private: failure === "private",
      locked: failure === "locked" ? { [key]: {} }
        : failure === "historically-locked" ? { [`${toolsName}@0.0.1`]: {} } : {},
      source: failure === "unrelated-release" ? runtimeName : toolsName,
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
