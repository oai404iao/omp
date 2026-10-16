import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { root, workspaces } from "../workspaces.mjs";

// Local notifications are deliberately tested but never a release workspace.
export const testPackages = [...workspaces, {
  name: "@oai404iao/pi-local-notify",
  directory: "pi-extensions/pi-local-notify",
  private: true,
}].map(entry => ({ ...entry, id: basename(entry.directory) }))
  .sort((a, b) => a.id.localeCompare(b.id));

export const suites = ["composition", "consumers", "infrastructure"];
export const integrationPackages = new Set(testPackages
  .filter(entry => entry.id.startsWith("pi-codex-") || entry.id === "pi-subagent")
  .map(entry => entry.id));
export const policyScripts = ["changeset:check", "pack:check", "license:check",
  "check:architecture", "test:architecture", "check:pi-baseline"];

export const taskCatalog = new Map([
  ["policy", { id: "policy", commands: policyScripts.map(script => ["pnpm", "run", script]) }],
  ...testPackages.map(entry => [`package:${entry.id}`, {
    id: `package:${entry.id}`,
    commands: [entry.private
      ? ["pnpm", "--dir", entry.directory, "run", "check"]
      : ["pnpm", "--filter", entry.name, "--fail-if-no-match", "run", "check"]],
  }]),
  ...Object.entries({ composition: "test:codex-composition", consumers: "test:codex-packages",
    infrastructure: "test:release-scripts" })
    .map(([id, script]) => [id, { id, commands: [["pnpm", "run", script]] }]),
]);

export function readPackage(entry, directory = root) {
  return JSON.parse(readFileSync(resolve(directory, entry.directory, "package.json"), "utf8"));
}

export function validateCatalog(entries = testPackages, manifestFor = readPackage) {
  for (const field of ["id", "name", "directory"]) {
    if (new Set(entries.map(entry => entry[field])).size !== entries.length) {
      throw new Error(`Duplicate test package ${field}`);
    }
  }
  for (const entry of entries) {
    const manifest = manifestFor(entry);
    if (manifest.name !== entry.name || !manifest.scripts?.check ||
        Boolean(manifest.private) !== Boolean(entry.private)) {
      throw new Error(`Invalid test package registration: ${entry.id}`);
    }
  }
}

/** Discovery is separate from graph construction so synthetic graph fixtures stay small. */
export function validateRepositoryCatalog(directory = root) {
  const extensions = resolve(directory, "pi-extensions");
  if (!lstatSync(extensions).isDirectory()) throw new Error("Invalid pi-extensions directory");
  const manifests = new Map();
  for (const entry of readdirSync(extensions, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`Symlink in test package discovery: ${entry.name}`);
    if (!entry.isDirectory()) continue;
    const packageDirectory = `pi-extensions/${entry.name}`;
    const manifestPath = resolve(directory, packageDirectory, "package.json");
    const stat = lstatSync(manifestPath, { throwIfNoEntry: false });
    if (!stat) continue;
    if (!stat.isFile()) throw new Error(`Invalid test package manifest: ${packageDirectory}`);
    manifests.set(packageDirectory, JSON.parse(readFileSync(manifestPath, "utf8")));
  }
  const expected = new Set(testPackages.map(entry => entry.directory));
  const missing = [...expected].filter(path => !manifests.has(path));
  const unregistered = [...manifests.keys()].filter(path => !expected.has(path)).sort();
  if (missing.length || unregistered.length) {
    throw new Error(`Test package catalog mismatch; missing: ${missing.join(", ") || "none"}; ` +
      `unregistered: ${unregistered.join(", ") || "none"}`);
  }
  validateCatalog(testPackages, entry => manifests.get(entry.directory));
}

/** All workspace edges matter for tests, unlike the runtime-only release closure. */
export function buildGraph(entries = testPackages, manifestFor = readPackage) {
  validateCatalog(entries, manifestFor);
  const byName = new Map(entries.map(entry => [entry.name, entry.id]));
  return new Map(entries.map(entry => {
    const manifest = manifestFor(entry);
    const dependencies = Object.assign({}, ...["dependencies", "optionalDependencies",
      "devDependencies", "peerDependencies"].map(field => manifest[field]));
    for (const [name, version] of Object.entries(dependencies)) {
      if (String(version).startsWith("workspace:") && !byName.has(name)) {
        throw new Error(`Unregistered workspace dependency: ${entry.id} -> ${name}`);
      }
    }
    return [entry.id, new Set(Object.keys(dependencies).filter(name => byName.has(name))
      .map(name => byName.get(name)))];
  }));
}

export function reverseClosure(selected, graphs) {
  const result = new Set(selected);
  let changed = true;
  while (changed) {
    changed = false;
    for (const graph of graphs) for (const [id, dependencies] of graph) {
      if (!result.has(id) && [...dependencies].some(dependency => result.has(dependency))) {
        result.add(id);
        changed = true;
      }
    }
  }
  return [...result].sort();
}
