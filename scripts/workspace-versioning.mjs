import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registry, root, workspaces } from "./workspaces.mjs";
import { readChangesets } from "@changesets/read";
import { orderReleaseWorkspaces } from "./release-dependencies.mjs";
import { preserveRegistryIntegrity } from "./lock-integrity.mjs";
import { readPnpmLock, writePnpmLock } from "./pnpm-lock.mjs";

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
  return repairExactPins(before, after);
}

function repairExactPins(before, after, preservedBootstrap) {
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
    if ((changed || dependencyChanged) && before.get(name)?.version === manifest.version
      && name !== preservedBootstrap) {
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
  if (!write) throw new Error("Dependent changesets are missing or stale; run pnpm run changeset:sync");
  for (const file of files) if (file !== filename || !expected) rmSync(join(directory, file));
  if (expected) writeFileSync(path, expected);
}

async function validateBootstrapVersion(cwd, manifests, name) {
  const entry = workspaces.find(entry => entry.name === name);
  const manifest = manifests.get(name);
  if (!entry || entry.releaseStatus !== "bootstrap" || manifest.private !== false) {
    throw new Error(`${name}: preserving an initial version requires a non-private bootstrap workspace`);
  }
  if (existsSync(join(cwd, ".changeset/pre.json"))) {
    throw new Error("Preserving a bootstrap version is not supported during Changesets prerelease mode");
  }
  const lock = JSON.parse(readFileSync(join(cwd, "release-locks/npm-published-artifacts.json"), "utf8"));
  if (lock.schemaVersion !== 1 || lock.registry !== registry || !lock.releases
    || typeof lock.releases !== "object" || Array.isArray(lock.releases)) {
    throw new Error("published-artifact lock is malformed or targets another registry");
  }
  // A historical publication disqualifies this one-time exception, even if npm
  // currently returns 404 or the checkout names a different version.
  if (Object.keys(lock.releases).some(key => key.startsWith(`${name}@`))) {
    throw new Error(`${name}: initial version is locked as published`);
  }
  const changesets = (await pendingChangesets(cwd)).filter(c => !generated(c.id));
  const explicit = changesets.some(c => c.releases.some(r => r.name === name && r.type !== "none"));
  if (!explicit && !dependentChangeset(manifests, changesets)?.includes(`${JSON.stringify(name)}: patch`)) {
    throw new Error(`${name}: bootstrap workspace is unrelated to the pending releases`);
  }
  // Query the package, not just the exact version: a package that has already
  // published anything is no longer an unpublished initial bootstrap.
  const response = await fetch(new URL(encodeURIComponent(name), registry), {
    redirect: "error", signal: AbortSignal.timeout(30_000), cache: "no-store",
  });
  if (response.status !== 404 || (await response.json())?.error !== "Not found") {
    throw new Error(`${name}: registry did not confirm an unpublished bootstrap package`);
  }
  return entry;
}

function restoreBootstrapVersion(cwd, before, after, entry) {
  const manifest = after.get(entry.name);
  const initialVersion = before.get(entry.name).version;
  const generatedVersion = manifest.version;
  if (generatedVersion === initialVersion) throw new Error(`${entry.name}: Changesets did not version the bootstrap workspace`);
  manifest.version = initialVersion;
  writeFileSync(join(cwd, entry.directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const dependencyReference = new RegExp(
    `${`${entry.name}@${generatedVersion}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w.+-])`, "g",
  );
  for (const workspace of workspaces) {
    const path = join(cwd, workspace.directory, "CHANGELOG.md");
    if (!existsSync(path)) continue;
    const previous = readFileSync(path, "utf8");
    let next = previous.replace(dependencyReference, `${entry.name}@${initialVersion}`);
    if (workspace.name === entry.name) {
      if (!next.includes(`\n## ${generatedVersion}\n`)) throw new Error(`${entry.name}: generated changelog heading is missing`);
      next = next.replace(`\n## ${generatedVersion}\n`, `\n## ${initialVersion}\n`);
      // A bootstrap may already document its initial version. Keep its notes
      // under the newly generated section instead of creating duplicate releases.
      const heading = `\n## ${initialVersion}\n`;
      const first = next.indexOf(heading);
      next = next.slice(0, first + heading.length)
        + next.slice(first + heading.length).replaceAll(heading, "\n");
    }
    if (next !== previous) writeFileSync(path, next);
  }
}

export async function versionWorkspace(cwd = root, {
  updateLock = true, preserveBootstrapVersion,
} = {}) {
  const before = workspaceManifests(cwd);
  const lockPath = join(cwd, "pnpm-lock.yaml");
  const previousLock = readPnpmLock(lockPath);
  // Fail before Changesets writes versions if an existing pin is already invalid.
  exactPinEdits(before, before);
  const bootstrap = preserveBootstrapVersion === undefined ? undefined
    : await validateBootstrapVersion(cwd, before, preserveBootstrapVersion);
  await syncDependentChangesets(cwd, true);
  if ((await pendingChangesets(cwd)).length === 0) return;
  run(cwd, join(cwd, "node_modules/.bin/changeset"), ["version"]);
  const after = workspaceManifests(cwd);
  if (bootstrap) restoreBootstrapVersion(cwd, before, after, bootstrap);
  const edits = repairExactPins(before, after, bootstrap?.name);
  for (const [name, manifest] of edits) {
    const entry = workspaces.find(entry => entry.name === name);
    writeFileSync(join(cwd, entry.directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  exactPinEdits(workspaceManifests(cwd), workspaceManifests(cwd));
  if (updateLock) {
    run(cwd, "pnpm", ["install", "--lockfile-only", "--ignore-scripts", "--no-frozen-lockfile"]);
    const lock = preserveRegistryIntegrity(previousLock, readPnpmLock(lockPath));
    writePnpmLock(lockPath, lock);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const usage = "usage: workspace-versioning.mjs check|sync|version [--preserve-bootstrap-version <exact-name>]";
  const [command, flag, name, ...extra] = process.argv.slice(2);
  const preserve = command === "version" && flag === "--preserve-bootstrap-version"
    && typeof name === "string" && !name.startsWith("-") && extra.length === 0;
  if ((flag !== undefined && !preserve) || (flag === undefined && name !== undefined)) throw new Error(usage);
  if (command === "version") await versionWorkspace(root, { preserveBootstrapVersion: preserve ? name : undefined });
  else if (command === "sync" || command === "check") await syncDependentChangesets(root, command === "sync");
  else throw new Error(usage);
}
