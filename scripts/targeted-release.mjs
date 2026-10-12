import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { assertReleaseDependencies, orderReleaseWorkspaces } from "./release-dependencies.mjs";
import { assertLockedPublishedArtifact, existingTagCommit } from "./release-utils.mjs";
import { readManifest, root, workspaces } from "./workspaces.mjs";

/** Select only the target and its complete runtime/optional workspace closure. */
export function targetedReleaseWorkspaces(requestedPackage, entries = workspaces, manifestFor = e => readManifest(e.directory)) {
  const selected = new Map();
  function visit(name) {
    if (selected.has(name)) return;
    const entry = entries.find(entry => entry.name === name);
    if (!entry || entry.releaseStatus !== "publishable") throw new Error(`Unapproved release target or dependency: ${name}`);
    const manifest = manifestFor(entry);
    if (manifest.private || manifest.name !== name) throw new Error(`Invalid release workspace identity: ${name}`);
    selected.set(name, entry);
    for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
      if (entries.some(entry => entry.name === dependency)) visit(dependency);
    }
  }
  visit(requestedPackage);
  const closure = [...selected.values()];
  assertReleaseDependencies(closure, entries, manifestFor);
  return orderReleaseWorkspaces(closure, manifestFor);
}

/** Verify immutable dependencies, not the possibly changed payload in this checkout. */
export function verifyDependencySource(candidate, published, commit, manifest = readManifest(candidate.directory)) {
  const { name, version, directory, sourceCommit, integrity, tag } = candidate;
  if (!published.exists || published.gitHead !== sourceCommit || published.integrity !== integrity) {
    throw new Error(`Published dependency identity or integrity mismatch: ${name}@${version}`);
  }
  if (!/^[0-9a-f]{40,64}$/i.test(sourceCommit) || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) {
    throw new Error(`Invalid dependency gitHead or SHA-512 integrity: ${name}@${version}`);
  }
  assertLockedPublishedArtifact(name, version, published);
  const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", sourceCommit, commit], { cwd: root, encoding: "utf8" });
  if (ancestry.status !== 0) throw new Error(`${name}@${version} npm gitHead ${sourceCommit} is not an ancestor of ${commit}`);
  const source = spawnSync("git", ["show", `${sourceCommit}:${directory}/package.json`], { cwd: root, encoding: "utf8" });
  if (source.status !== 0) throw new Error(`${name}@${version} package.json is unavailable at npm gitHead ${sourceCommit}`);
  const historical = JSON.parse(source.stdout);
  if (historical.private || historical.name !== name || historical.version !== version) {
    throw new Error(`${name}@${version} does not match package identity at npm gitHead ${sourceCommit}`);
  }
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta"]) {
    if (!isDeepStrictEqual(historical[field], manifest[field])) {
      throw new Error(`${name}@${version} historical ${field} differs from checkout`);
    }
  }
  const tagCommit = existingTagCommit(tag);
  if (tagCommit && tagCommit !== sourceCommit) throw new Error(`tag ${tag} points to ${tagCommit}, expected ${sourceCommit}`);
}
