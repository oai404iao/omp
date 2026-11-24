import { spawnSync } from "node:child_process";
import { assertReleaseDependencies, orderReleaseWorkspaces, workspaceDependencies } from "./release-dependencies.mjs";
import { assertLockedPublishedArtifact, currentCommit, existingTagCommit } from "./release-utils.mjs";
import { readManifest, root, workspaces } from "./workspaces.mjs";

/** Name-based runtime/optional closure; source checks need not use the checkout's dependency versions. */
export function targetedSourceWorkspaces(requestedPackage, entries = workspaces, manifestFor = e => readManifest(e.directory),
  { bootstrapTarget = false } = {}) {
  const byName = new Map(entries.map(entry => [entry.name, entry]));
  const selected = new Map();
  function visit(name) {
    if (selected.has(name)) return;
    const entry = byName.get(name);
    const expectedStatus = bootstrapTarget && name === requestedPackage ? "bootstrap" : "publishable";
    if (!entry || entry.releaseStatus !== expectedStatus) throw new Error(`Unapproved release target or dependency: ${name}`);
    const manifest = manifestFor(entry);
    if (manifest.private || manifest.name !== name) throw new Error(`Invalid release workspace identity: ${name}`);
    selected.set(name, entry);
    for (const [dependency] of workspaceDependencies(manifest, byName)) visit(dependency);
  }
  for (const target of Array.isArray(requestedPackage) ? requestedPackage : [requestedPackage]) visit(target);
  return orderReleaseWorkspaces([...selected.values()], manifestFor);
}

/** Artifact validation additionally requires every concrete version to satisfy its incoming edges. */
export function targetedReleaseWorkspaces(requestedPackage, entries = workspaces, manifestFor = e => readManifest(e.directory), options) {
  const closure = targetedSourceWorkspaces(requestedPackage, entries, manifestFor, options);
  assertReleaseDependencies(closure, entries, manifestFor);
  return closure;
}

export function historicalManifest({ name, version, directory, sourceCommit, tag }, commit = currentCommit()) {
  if (!/^[0-9a-f]{40,64}$/i.test(sourceCommit)) throw new Error(`Invalid dependency gitHead: ${name}@${version}`);
  const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", sourceCommit, commit], { cwd: root, encoding: "utf8" });
  if (ancestry.status !== 0) throw new Error(`${name}@${version} npm gitHead ${sourceCommit} is not an ancestor of ${commit}`);
  const source = spawnSync("git", ["show", `${sourceCommit}:${directory}/package.json`], { cwd: root, encoding: "utf8" });
  if (source.status !== 0) throw new Error(`${name}@${version} package.json is unavailable at npm gitHead ${sourceCommit}`);
  const historical = JSON.parse(source.stdout);
  if (historical.private || historical.name !== name || historical.version !== version) {
    throw new Error(`${name}@${version} does not match package identity at npm gitHead ${sourceCommit}`);
  }
  const tagCommit = existingTagCommit(tag);
  if (tagCommit && tagCommit !== sourceCommit) throw new Error(`tag ${tag} points to ${tagCommit}, expected ${sourceCommit}`);
  return historical;
}

/** The source of truth is the published commit, not the current workspace manifest. */
export function verifyDependencySource(candidate, published, commit) {
  const { name, version, sourceCommit, integrity } = candidate;
  if (!published.exists || published.gitHead !== sourceCommit || published.integrity !== integrity) {
    throw new Error(`Published dependency identity or integrity mismatch: ${name}@${version}`);
  }
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) throw new Error(`Invalid dependency SHA-512 integrity: ${name}@${version}`);
  assertLockedPublishedArtifact(name, version, published);
  return historicalManifest(candidate, commit);
}
