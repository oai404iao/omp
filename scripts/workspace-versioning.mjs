import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { root, workspaces } from "./workspaces.mjs";
import { readChangesets } from "@changesets/read";
import { orderReleaseWorkspaces } from "./release-dependencies.mjs";
import { preserveRegistryIntegrity } from "./lock-integrity.mjs";

export const generatedId = "workspace-dependent-releases";
export const dependencyFields = ["dependencies", "optionalDependencies"];
const generated = id => id === generatedId || id.startsWith(`${generatedId}-`);

export function workspaceManifests(cwd = root) {
  return new Map(workspaces.map(entry => [
    entry.name, JSON.parse(readFileSync(join(cwd, entry.directory, "package.json"), "utf8")),
  ]));
}

export function dependentChangeset(manifests, changesets) {
  const explicit = new Set(changesets.filter(c => !generated(c.id))
    .flatMap(c => c.releases.filter(r => r.type !== "none").map(r => r.name)));
  const affected = new Set(explicit);
  let changed;
  do {
    changed = false;
    for (const [name, manifest] of manifests) {
      if (affected.has(name)) continue;
      const dependencies = dependencyFields.flatMap(field => Object.keys(manifest[field] ?? {}));
      if (dependencies.some(dep => affected.has(dep))) {
        affected.add(name);
        changed = true;
      }
    }
  } while (changed);
  const consumers = [...affected].filter(name => manifests.has(name) && !explicit.has(name)).sort();
  if (!consumers.length) return undefined;
  return `---\n${consumers.map(name => `${JSON.stringify(name)}: patch`).join("\n")}\n---\n\nUpdate exact workspace dependency pins for the pending dependency releases.\n`;
}

export function exactPinEdits(before, after) {
  const edits = [];
  for (const [name, manifest] of after) {
    const next = structuredClone(manifest);
    let changed = false;
    for (const field of dependencyFields) {
      for (const dep of Object.keys(next[field] ?? {})) {
        if (!after.has(dep)) continue;
        const version = after.get(dep).version;
        if (next[field][dep] === version) continue;
        next[field][dep] = version;
        changed = true;
      }
    }
    const dependencyChanged = dependencyFields.some(field =>
      Object.keys(before.get(name)?.[field] ?? {}).some(dep =>
        after.has(dep) && before.get(name)[field][dep] !== after.get(dep).version));
    if ((changed || dependencyChanged) && before.get(name)?.version === manifest.version) {
      throw new Error(`${name}: changing a workspace dependency pin requires a consumer version bump`);
    }
    if (changed) edits.push([name, next]);
  }
  return edits;
}

function run(cwd, executable, args) {
  const result = spawnSync(executable, args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) throw new Error(`${executable} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

async function pendingChangesets(cwd) {
  const changesets = await readChangesets(cwd);
  const path = join(cwd, ".changeset/pre.json");
  const state = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
  // Match Changesets 3: pre/ contains already-consumed entries until pre exit.
  return state && state.mode !== "exit" ? changesets.filter(c => !c.id.startsWith("pre/")) : changesets;
}

export async function syncDependentChangesets(cwd = root, write = false) {
  const manifests = workspaceManifests(cwd);
  orderReleaseWorkspaces(workspaces, entry => manifests.get(entry.name));
  exactPinEdits(manifests, manifests);
  const changesets = await pendingChangesets(cwd);
  for (const release of changesets.flatMap(c => c.releases)) {
    if (!manifests.has(release.name)) throw new Error(`Changeset references unknown workspace: ${release.name}`);
  }
  const expected = dependentChangeset(manifests, changesets);
  const directory = join(cwd, ".changeset");
  const files = readdirSync(directory).filter(name => name.endsWith(".md") && generated(name.slice(0, -3)));
  // Changesets keeps consumed pre entries on disk. Never overwrite an earlier
  // generation's consumer record when releasing another prerelease iteration.
  const suffix = existsSync(join(directory, "pre", `${generatedId}.md`))
    ? `-${createHash("sha256").update(JSON.stringify(changesets.filter(c => !generated(c.id)).map(c => c.id).sort())).digest("hex").slice(0, 24)}`
    : "";
  const filename = `${generatedId}${suffix}.md`;
  const path = join(directory, filename);
  const current = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  if (expected === current && files.length === (expected ? 1 : 0)) return;
  if (!write) throw new Error("Dependent changesets are missing or stale; run npm run changeset:sync");
  for (const file of files) if (file !== filename || !expected) rmSync(join(directory, file));
  if (expected) writeFileSync(path, expected);
}

export async function versionWorkspace(cwd = root, { updateLock = true } = {}) {
  const before = workspaceManifests(cwd);
  const lockPath = join(cwd, "package-lock.json");
  const previousLock = JSON.parse(readFileSync(lockPath, "utf8"));
  // Fail before Changesets writes versions if an existing pin is already invalid.
  exactPinEdits(before, before);
  await syncDependentChangesets(cwd, true);
  if ((await pendingChangesets(cwd)).length === 0) return;
  run(cwd, join(cwd, "node_modules/.bin/changeset"), ["version"]);
  const after = workspaceManifests(cwd);
  const edits = exactPinEdits(before, after);
  for (const [name, manifest] of edits) {
    const entry = workspaces.find(entry => entry.name === name);
    writeFileSync(join(cwd, entry.directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  exactPinEdits(workspaceManifests(cwd), workspaceManifests(cwd));
  if (updateLock) {
    run(cwd, "npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"]);
    const lock = preserveRegistryIntegrity(previousLock, JSON.parse(readFileSync(lockPath, "utf8")));
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error("usage: workspace-versioning.mjs check|sync|version");
  const command = process.argv[2];
  if (command === "version") await versionWorkspace();
  else if (command === "sync" || command === "check") await syncDependentChangesets(root, command === "sync");
  else throw new Error("usage: workspace-versioning.mjs check|sync|version");
}
