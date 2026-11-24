import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { isDeepStrictEqual } from "node:util";
import semver from "semver";
import { readManifest, workspaces } from "./workspaces.mjs";
import { sha512 } from "./release-utils.mjs";
import { historicalManifest, targetedReleaseWorkspaces } from "./targeted-release.mjs";

export function validateReleaseBatch(candidates, entries = workspaces, manifestFor = e => readManifest(e.directory),
  targets, sourceManifest = historicalManifest) {
  const byName = new Map(candidates.map(candidate => [candidate.name, candidate]));
  if (!targets?.length || byName.size !== candidates.length) throw new Error("Missing release targets or duplicate candidate");
  const manifests = new Map();
  for (const candidate of candidates) {
    const entry = entries.find(entry => entry.name === candidate.name);
    if (!entry || entry.releaseStatus !== "publishable") throw new Error(`Unapproved release candidate: ${candidate.name}`);
    const manifest = manifestFor(entry);
    const target = targets.includes(candidate.name);
    if (manifest.private || manifest.name !== candidate.name || (target && manifest.version !== candidate.version) || entry.directory !== candidate.directory) {
      throw new Error(`Release candidate differs from checkout: ${candidate.name}`);
    }
    const modes = target ? ["publish", "recover"] : ["verify"];
    if (!modes.includes(candidate.mode)) throw new Error(`Invalid release mode: ${candidate.name}`);
    if (!candidate.version || semver.valid(candidate.version) !== candidate.version) throw new Error(`Invalid candidate version: ${candidate.name}`);
    const prerelease = !!semver.prerelease(candidate.version);
    if (candidate.tag !== `${candidate.name}@${candidate.version}` || candidate.prerelease !== prerelease
      || candidate.distTag !== (prerelease ? "next" : "latest")
      || !/^[0-9a-f]{40,64}$/i.test(candidate.sourceCommit)
      || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(candidate.integrity)) {
      throw new Error(`Invalid release identity or dist-tag: ${candidate.name}`);
    }
    const source = candidate.mode === "publish" ? manifest : sourceManifest(candidate);
    if (candidate.mode === "recover" && !isDeepStrictEqual(source, manifest)) throw new Error(`Recovery manifest differs from checkout: ${candidate.name}`);
    manifests.set(candidate.name, source);
  }
  const closure = targetedReleaseWorkspaces(targets, entries, entry => {
    if (!manifests.has(entry.name)) throw new Error(`Missing candidate in requested package dependency closure: ${entry.name}`);
    return manifests.get(entry.name);
  });
  if (closure.length !== candidates.length) throw new Error("Release batch must contain exactly the requested package dependency closure");
  return closure.map(entry => byName.get(entry.name));
}

export function verifyPackedCandidate(candidate, path, manifest = readManifest(candidate.directory)) {
  if (basename(candidate.filename) !== candidate.filename || !candidate.filename.endsWith(".tgz")) {
    throw new Error("Invalid release artifact filename");
  }
  if (sha512(path) !== candidate.integrity) throw new Error(`artifact integrity mismatch for ${candidate.filename}`);
  const result = spawnSync("tar", ["-xOf", path, "package/package.json"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Cannot inspect artifact manifest: ${candidate.filename}`);
  const packed = JSON.parse(result.stdout);
  if (packed.private || packed.gitHead !== candidate.sourceCommit) throw new Error("Invalid packed release identity");
  for (const field of ["name", "version", "dependencies", "optionalDependencies", "peerDependencies",
    "peerDependenciesMeta", "license", "repository", "exports", "pi", "engines", "publishConfig"]) {
    if (!isDeepStrictEqual(packed[field], manifest[field])) throw new Error(`Packed ${field} differs from checkout: ${candidate.name}`);
  }
}

/** A dependent must never publish before its exact dependency is registry-visible. */
export function publishOrderedBatch(candidates, { publish, verify }) {
  const warnings = [];
  for (const candidate of candidates) {
    try {
      if (candidate.mode === "publish") publish(candidate);
      verify(candidate);
    } catch (error) {
      warnings.push({ name: candidate.name, message: String(error.message ?? error) });
      break;
    }
  }
  return warnings;
}
