import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  dependentChangeset, exactPinEdits, generatedId, syncDependentChangesets,
  versionWorkspace, workspaceManifests,
} from "./workspace-versioning.mjs";
import { root, workspaces } from "./workspaces.mjs";

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
test(`real Changesets ${prerelease ? "pre/exit" : "normal"} versioning propagates runtime-only release through capabilities, bundle and subagent`, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "omp-version-fixture-"));
  try {
    mkdirSync(join(cwd, ".changeset"));
    writeFileSync(join(cwd, "package-lock.json"), readFileSync(join(root, "package-lock.json")));
    writeFileSync(join(cwd, "package.json"), JSON.stringify({
      name: "fixture", private: true, workspaces: workspaces.map(e => e.directory),
    }));
    writeFileSync(join(cwd, ".changeset/config.json"), readFileSync(join(root, ".changeset/config.json")));
    const before = workspaceManifests();
    for (const entry of workspaces) {
      mkdirSync(join(cwd, entry.directory), { recursive: true });
      writeFileSync(join(cwd, entry.directory, "package.json"), JSON.stringify(before.get(entry.name)));
    }
    symlinkSync(join(root, "node_modules"), join(cwd, "node_modules"), "dir");
    writeFileSync(join(cwd, ".gitignore"), "node_modules/\n");
    writeFileSync(join(cwd, ".changeset/runtime-only.md"), '---\n"@oai404iao/pi-codex-runtime": patch\n---\n\nRuntime fixture.\n');
    const git = args => {
      const result = spawnSync("git", args, { cwd, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    };
    git(["init", "-b", "main"]);
    git(["add", "."]);
    git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"]);
    const pre = command => {
      const result = spawnSync(join(cwd, "node_modules/.bin/changeset"), ["pre", command, ...(command === "enter" ? ["next"] : [])], { cwd, encoding: "utf8" });
      assert.equal(result.status, 0, result.stdout + result.stderr);
    };
    if (prerelease) pre("enter");
    await assert.rejects(syncDependentChangesets(cwd), /missing or stale/);
    await syncDependentChangesets(cwd, true);
    await assert.doesNotReject(syncDependentChangesets(cwd));
    const generated = readFileSync(join(cwd, ".changeset", `${generatedId}.md`), "utf8");
    assert.ok(generated.includes('"@oai404iao/pi-subagent": patch'));
    await versionWorkspace(cwd, { updateLock: false });
    const after = workspaceManifests(cwd);
    for (const name of ["pi-codex-runtime", "pi-codex-core", "pi-codex-web-search", "pi-codex-imagegen", "pi-codex-minimal-tools", "pi-subagent"]) {
      assert.notEqual(after.get(`@oai404iao/${name}`).version, before.get(`@oai404iao/${name}`).version);
    }
    assert.equal(after.get("@oai404iao/pi-subagent").optionalDependencies["@oai404iao/pi-codex-minimal-tools"],
      after.get("@oai404iao/pi-codex-minimal-tools").version);
    for (const [name, manifest] of after) {
      if (name.startsWith("@oai404iao/pi-codex-") && name !== "@oai404iao/pi-codex-minimal-tools") assert.equal(manifest.private, true);
    }
    assert.deepEqual(exactPinEdits(after, after), []);
    await versionWorkspace(cwd, { updateLock: false });
    assert.deepEqual(workspaceManifests(cwd), after);
    if (prerelease) {
      assert.match(after.get("@oai404iao/pi-codex-core").version, /-next\./);
      const historyPath = join(cwd, ".changeset/pre", `${generatedId}.md`);
      const history = readFileSync(historyPath, "utf8");
      writeFileSync(join(cwd, ".changeset/web-next.md"), '---\n"@oai404iao/pi-codex-web-search": patch\n---\n\nNext web fixture.\n');
      await versionWorkspace(cwd, { updateLock: false });
      const next = workspaceManifests(cwd);
      assert.equal(next.get("@oai404iao/pi-codex-runtime").version, after.get("@oai404iao/pi-codex-runtime").version);
      assert.equal(next.get("@oai404iao/pi-codex-core").version, after.get("@oai404iao/pi-codex-core").version);
      assert.notEqual(next.get("@oai404iao/pi-codex-web-search").version, after.get("@oai404iao/pi-codex-web-search").version);
      assert.equal(readFileSync(historyPath, "utf8"), history);
      await versionWorkspace(cwd, { updateLock: false });
      assert.deepEqual(workspaceManifests(cwd), next);
      pre("exit");
      await versionWorkspace(cwd, { updateLock: false });
      const stable = workspaceManifests(cwd);
      assert.doesNotMatch(stable.get("@oai404iao/pi-codex-core").version, /-/);
      assert.deepEqual(exactPinEdits(stable, stable), []);
    }
    assert.deepEqual(workspaceManifests(), before, "fixture must not change real workspace versions");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
}
