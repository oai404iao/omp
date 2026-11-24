import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registry, root, workspaces } from "./workspaces.mjs";
import { readChangesets } from "@changesets/read";
import semver from "semver";
import { orderReleaseWorkspaces } from "./release-dependencies.mjs";
import { preserveRegistryIntegrity } from "./lock-integrity.mjs";
import { readPnpmLock, writePnpmLock } from "./pnpm-lock.mjs";
import { isWorkspaceRange, satisfiesWorkspaceDependency } from "./workspace-ranges.mjs";

const dependencyFields = ["dependencies", "optionalDependencies"];
const migrationFile = ".changeset/codex-compatibility-floors.json";

export function workspaceManifests(cwd = root) {
  return new Map(workspaces.map(entry => [
    entry.name, JSON.parse(readFileSync(join(cwd, entry.directory, "package.json"), "utf8")),
  ]));
}

// The old broker requires identical runtimes. Only the coordinated stable
// version PR can introduce ranges: none may include the old strict artifacts.
function migrationEdits(cwd, manifests, changesets) {
  const path = join(cwd, migrationFile);
  if (!existsSync(path)) return [];
  if (existsSync(join(cwd, ".changeset/pre.json"))) throw new Error("Codex range migration requires stable releases");
  const plan = JSON.parse(readFileSync(path, "utf8"));
  const explicit = changesets.flatMap(c => c.releases).filter(r => r.type !== "none");
  const edits = [];
  for (const [consumer, dependencies] of Object.entries(plan)) {
    for (const [dep, range] of Object.entries(dependencies)) {
      const version = manifests.get(dep)?.version;
      const fields = dependencyFields.filter(field => Object.hasOwn(manifests.get(consumer)?.[field] ?? {}, dep));
      if (fields.length !== 1 || !version || manifests.get(consumer)[fields[0]][dep] !== version
        || semver.prerelease(version) || range !== `^${semver.inc(version, "patch")}`) {
        throw new Error(`Invalid migration edge or first compatible version: ${consumer} -> ${dep} ${range}`);
      }
      for (const name of [consumer, dep]) {
        const bumps = explicit.filter(r => r.name === name);
        if (!bumps.length || bumps.some(r => r.type !== "patch")) {
          throw new Error(`Codex range migration requires an explicit patch release for ${name}`);
        }
      }
      edits.push({ consumer, dep, field: fields[0], range });
    }
  }
  if (!edits.length) throw new Error("Empty Codex range migration");
  return edits;
}

function run(cwd, executable, args) {
  const result = spawnSync(executable, args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) throw new Error(`${executable} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function validateDependencies(manifests, staged = []) {
  orderReleaseWorkspaces(workspaces, entry => manifests.get(entry.name));
  for (const [consumer, manifest] of manifests) {
    if (semver.valid(manifest.version) !== manifest.version || typeof manifest.version !== "string") {
      throw new Error(`Invalid workspace version: ${consumer}@${manifest.version}`);
    }
    for (const field of dependencyFields) for (const [dep, declaration] of Object.entries(manifest[field] ?? {})) {
      if (!manifests.has(dep)) continue;
      const migrating = staged.some(edit => edit.consumer === consumer && edit.dep === dep && edit.field === field);
      if (!migrating && !isWorkspaceRange(declaration)) {
        throw new Error(`${consumer}: ${dep} requires a numeric caret declaration, got ${declaration}`);
      }
    }
  }
}

export async function checkWorkspace(cwd = root) {
  const manifests = workspaceManifests(cwd);
  const prePath = join(cwd, ".changeset/pre.json");
  const pre = existsSync(prePath) ? JSON.parse(readFileSync(prePath, "utf8")) : undefined;
  const changesets = (await readChangesets(cwd)).filter(c => !pre || pre.mode === "exit" || !c.id.startsWith("pre/"));
  for (const { name } of changesets.flatMap(c => c.releases)) {
    if (!manifests.has(name)) throw new Error(`Changeset references unknown workspace: ${name}`);
  }
  const edits = migrationEdits(cwd, manifests, changesets);
  validateDependencies(manifests, edits);
  return { before: manifests, changesets, edits };
}

// A frozen pnpm lock can retain link: after a provider crosses a major or
// prerelease boundary without any specifier changing. Resolve just those edges
// again; retain reviewed registry identities everywhere else.
export function staleWorkspaceResolutions(lock, manifests, entries = workspaces) {
  const dirs = new Map(entries.map(e => [e.name, e.directory]));
  const stale = [];
  for (const [name, manifest] of manifests) {
    const directory = dirs.get(name);
    for (const field of dependencyFields) for (const [dep, specifier] of Object.entries(manifest[field] ?? {})) {
      if (!dirs.has(dep)) continue;
      const ref = lock.importers?.[directory]?.[field]?.[dep];
      const version = manifests.get(dep).version;
      const pinned = ref?.version?.split("(")[0];
      const resolution = lock.packages?.[`${dep}@${pinned}`]?.resolution;
      const compatible = satisfiesWorkspaceDependency(version, specifier);
      const correct = compatible ? ref?.version === `link:${relative(directory, dirs.get(dep))}`
        : satisfiesWorkspaceDependency(pinned, specifier) && resolution?.integrity && !resolution.type
          && resolution.tarball?.startsWith(registry) && lock.snapshots?.[`${dep}@${ref.version}`];
      if (!correct || ref?.specifier !== specifier) stale.push({ directory, field, dep });
    }
  }
  return stale;
}

function checkResolutions(lock, manifests) {
  const stale = staleWorkspaceResolutions(lock, manifests);
  if (stale.length) throw new Error(`Stale workspace dependency resolutions in pnpm-lock.yaml: ${JSON.stringify(stale)}`);
}

async function validateBootstrapVersion(cwd, manifests, name, changesets) {
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
  const explicit = changesets.some(c => c.releases.some(r => r.name === name && r.type !== "none"));
  if (!explicit) {
    throw new Error(`${name}: preserving a bootstrap version requires its own pending changeset`);
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
  const { before, changesets, edits } = await checkWorkspace(cwd);
  const lockPath = join(cwd, "pnpm-lock.yaml");
  const previousLock = readPnpmLock(lockPath);
  if (edits.length && preserveBootstrapVersion !== undefined) throw new Error("Cannot combine bootstrap and Codex range migration");
  const bootstrap = preserveBootstrapVersion === undefined ? undefined
    : await validateBootstrapVersion(cwd, before, preserveBootstrapVersion, changesets);
  if (!changesets.length) return;
  run(cwd, join(cwd, "node_modules/.bin/changeset"), ["version"]);
  const after = workspaceManifests(cwd);
  if (bootstrap) restoreBootstrapVersion(cwd, before, after, bootstrap);
  for (const { consumer, dep, field, range } of edits) {
    if (range !== `^${after.get(dep).version}` || before.get(consumer).version === after.get(consumer).version) {
      throw new Error(`Migration floor did not land in this version PR: ${consumer} -> ${dep} ${range}`);
    }
    after.get(consumer)[field][dep] = range;
  }
  validateDependencies(after);
  for (const name of new Set(edits.map(edit => edit.consumer))) {
    const { directory } = workspaces.find(entry => entry.name === name);
    writeFileSync(join(cwd, directory, "package.json"), `${JSON.stringify(after.get(name), null, 2)}\n`);
  }
  if (updateLock) {
    const stale = staleWorkspaceResolutions(previousLock, after);
    if (stale.length) {
      const next = structuredClone(previousLock);
      for (const { directory, field, dep } of stale) delete next.importers[directory]?.[field]?.[dep];
      writePnpmLock(lockPath, next);
    }
    run(cwd, "pnpm", ["install", "--lockfile-only", "--ignore-scripts", "--no-frozen-lockfile"]);
    const lock = preserveRegistryIntegrity(previousLock, readPnpmLock(lockPath));
    checkResolutions(lock, after);
    writePnpmLock(lockPath, lock);
  }
  if (edits.length) unlinkSync(join(cwd, migrationFile));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const usage = "usage: workspace-versioning.mjs check|version [--preserve-bootstrap-version <exact-name>]";
  const [command, flag, name, ...extra] = process.argv.slice(2);
  const preserve = command === "version" && flag === "--preserve-bootstrap-version"
    && typeof name === "string" && !name.startsWith("-") && extra.length === 0;
  if ((flag !== undefined && !preserve) || (flag === undefined && name !== undefined)) throw new Error(usage);
  if (command === "version") await versionWorkspace(root, { preserveBootstrapVersion: preserve ? name : undefined });
  else if (command === "check") checkResolutions(readPnpmLock(join(root, "pnpm-lock.yaml")), (await checkWorkspace(root)).before);
  else throw new Error(usage);
}
