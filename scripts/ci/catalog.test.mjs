import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { root, workspaces } from "../workspaces.mjs";
import { buildGraph, integrationPackages, policyScripts, readPackage, reverseClosure,
  taskCatalog, testPackages, validateCatalog, validateRepositoryCatalog } from "./catalog.mjs";

function repositoryFixture() {
  const scratch = join(homedir(), ".local/state/agents/tmp");
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, "omp-ci-catalog-"));
  for (const entry of testPackages) {
    mkdirSync(resolve(directory, entry.directory), { recursive: true });
    writeFileSync(resolve(directory, entry.directory, "package.json"), JSON.stringify(readPackage(entry)));
  }
  return directory;
}

test("catalog registers every release package and explicit private notification target", () => {
  validateCatalog();
  validateRepositoryCatalog();
  assert.equal(testPackages.length, workspaces.length + 1);
  assert.deepEqual(testPackages.filter(entry => !entry.private).map(entry => entry.name).sort(),
    workspaces.map(entry => entry.name).sort());
  const local = testPackages.find(entry => entry.id === "pi-local-notify");
  assert.equal(local.name, readPackage(local).name);
  assert.deepEqual(taskCatalog.get(`package:${local.id}`).commands,
    [["pnpm", "--dir", local.directory, "run", "check"]]);
  assert.equal(integrationPackages.size, 7);
  assert.ok(integrationPackages.has("pi-subagent"));
  assert.deepEqual(taskCatalog.get("policy").commands, policyScripts.map(script => ["pnpm", "run", script]));
  for (const entry of testPackages.filter(entry => !entry.private)) {
    assert.ok(taskCatalog.get(`package:${entry.id}`).commands[0].includes("--fail-if-no-match"));
  }
});

test("pnpm release workspace configuration exactly matches the release catalog", () => {
  const config = parse(readFileSync(resolve(root, "pnpm-workspace.yaml"), "utf8"));
  assert.equal(workspaces.length, 8);
  assert.deepEqual([...config.packages].sort(), workspaces.map(entry => entry.directory).sort());
  assert.ok(!config.packages.includes("pi-extensions/pi-local-notify"));
});

test("repository discovery rejects unregistered, missing, malformed and symlinked packages", () => {
  const directory = repositoryFixture();
  validateRepositoryCatalog(directory);
  mkdirSync(resolve(directory, "pi-extensions/unused-directory"));
  validateRepositoryCatalog(directory);
  mkdirSync(resolve(directory, "pi-extensions/new-plugin"));
  writeFileSync(resolve(directory, "pi-extensions/new-plugin/package.json"), JSON.stringify({ name: "new-plugin" }));
  assert.throws(() => validateRepositoryCatalog(directory), /unregistered: pi-extensions\/new-plugin/);

  const missing = repositoryFixture();
  renameSync(resolve(missing, testPackages[0].directory, "package.json"), resolve(missing, "removed-manifest.json"));
  assert.throws(() => validateRepositoryCatalog(missing), /catalog mismatch; missing:/);

  const malformed = repositoryFixture();
  writeFileSync(resolve(malformed, testPackages[0].directory, "package.json"), "not JSON");
  assert.throws(() => validateRepositoryCatalog(malformed), SyntaxError);

  const linkedDirectory = repositoryFixture();
  symlinkSync(resolve(linkedDirectory, testPackages[0].directory), resolve(linkedDirectory, "pi-extensions/linked-plugin"), "dir");
  assert.throws(() => validateRepositoryCatalog(linkedDirectory), /Symlink/);

  const linkedManifest = repositoryFixture();
  const manifest = resolve(linkedManifest, testPackages[0].directory, "package.json");
  renameSync(manifest, resolve(linkedManifest, "original-manifest.json"));
  symlinkSync(resolve(linkedManifest, "original-manifest.json"), manifest);
  assert.throws(() => validateRepositoryCatalog(linkedManifest), /Invalid test package manifest/);
});

test("registration rejects duplicate identities, missing checks, and unregistered workspace edges", () => {
  const entry = { id: "one", name: "one", directory: "one" };
  const manifest = { name: "one", scripts: { check: "check" } };
  assert.throws(() => validateCatalog([entry, entry], () => manifest), /Duplicate/);
  assert.throws(() => validateCatalog([entry], () => ({ ...manifest, name: "wrong" })), /registration/);
  assert.throws(() => validateCatalog([entry], () => ({ name: "one" })), /registration/);
  assert.throws(() => buildGraph([entry], () => ({ ...manifest, dependencies: { missing: "workspace:*" } })), /Unregistered/);
});

test("graph includes runtime, optional, dev, and peer edges without root pseudo-package", () => {
  const entries = ["a", "b", "c", "d", "e"].map(id => ({ id, name: id, directory: id }));
  const graph = buildGraph(entries, entry => ({ name: entry.name, scripts: { check: "check" },
    ...(entry.id === "a" ? { dependencies: { b: "1" }, optionalDependencies: { c: "1" },
      devDependencies: { d: "workspace:*" }, peerDependencies: { e: "*", external: "*" } } : {}) }));
  assert.deepEqual([...graph.get("a")], ["b", "c", "d", "e"]);
  assert.deepEqual(reverseClosure(["c"], [graph]), ["a", "c"]);
  assert.equal(graph.size, 5);
  const oldGraph = new Map([["e", new Set(["a"])]]);
  assert.deepEqual(reverseClosure(["c"], [graph, oldGraph]), ["a", "c", "e"]);
});
