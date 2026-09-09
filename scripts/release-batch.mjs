import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { assertReleaseDependencies, orderReleaseWorkspaces } from "./release-dependencies.mjs";
import { readManifest, workspaces } from "./workspaces.mjs";
import { sha512 } from "./release-utils.mjs";

export function validateReleaseBatch(candidates, entries = workspaces, manifestFor = e => readManifest(e.directory)) {
  const selected = candidates.map(candidate => {
    const entry = entries.find(entry => entry.name === candidate.name);
    if (!entry || entry.releaseStatus !== "publishable") throw new Error(`Unapproved release candidate: ${candidate.name}`);
    const manifest = manifestFor(entry);
    if (manifest.private || manifest.version !== candidate.version || entry.directory !== candidate.directory) {
      throw new Error(`Release candidate differs from checkout: ${candidate.name}`);
    }
    if (!["publish", "recover"].includes(candidate.mode)) throw new Error(`Invalid release mode: ${candidate.name}`);
    const prerelease = manifest.version.includes("-");
    if (candidate.tag !== `${candidate.name}@${candidate.version}` || candidate.prerelease !== prerelease
      || candidate.distTag !== (prerelease ? "next" : "latest")
      || !/^[0-9a-f]{40,64}$/i.test(candidate.sourceCommit)
      || !candidate.integrity?.startsWith("sha512-")) {
      throw new Error(`Invalid release identity or dist-tag: ${candidate.name}`);
    }
    return entry;
  });
  assertReleaseDependencies(selected, entries, manifestFor);
  return orderReleaseWorkspaces(selected, manifestFor).map(entry => candidates.find(c => c.name === entry.name));
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
