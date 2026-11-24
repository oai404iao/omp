import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { validateReleaseBatch, verifyPackedCandidate } from "./release-batch.mjs";
import { assertLockedPublishedArtifact, currentCommit } from "./release-utils.mjs";
import { historicalManifest, verifyDependencySource } from "./targeted-release.mjs";
import { releaseTargets } from "./release-selection.mjs";
import { registry, workspaces, readManifest } from "./workspaces.mjs";

export { historicalManifest };

export const digest = bytes => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
export const canonicalTarball = ({ name, version }) => `${registry}${name}/-/${name.split("/").at(-1)}-${version}.tgz`;

/** No redirects, credentials, alternate registries, unbounded bodies or retries. */
export async function boundedFetch(url, limit, transport = globalThis.fetch) {
  const response = await transport(url, { redirect: "error", signal: AbortSignal.timeout(60_000),
    headers: { accept: "application/json, application/octet-stream", "cache-control": "no-cache" } });
  if (!response.ok || response.redirected || (response.url && response.url !== url)) throw new Error(`Unexpected registry response: ${url}`);
  if (Number(response.headers.get("content-length")) > limit) throw new Error("Registry response exceeds size limit");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error("Registry response exceeds size limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function validateManifest(manifest, { commit = currentCommit(), entries = workspaces,
  manifestFor = entry => readManifest(entry.directory), env = process.env, requestedPackage = env.RELEASE_PACKAGE,
  historicalManifest: source = historicalManifest } = {}) {
  const targets = releaseTargets(requestedPackage, entries);
  if (manifest.schemaVersion !== 2 || manifest.commit !== commit || manifest.registry !== registry
    || !Array.isArray(manifest.candidates) || manifest.candidates.length === 0
    || !isDeepStrictEqual(manifest.requestedPackages, targets)) throw new Error("Invalid release manifest or selection: does not match RELEASE_PACKAGE");
  if (env.GITHUB_SHA && env.GITHUB_SHA !== commit) throw new Error("Release checkout differs from GITHUB_SHA");
  const candidates = validateReleaseBatch(manifest.candidates, entries, manifestFor, targets, c => source(c, commit));
  for (const candidate of candidates) {
    if (candidate.mode === "publish" && candidate.sourceCommit !== commit) throw new Error("Publish candidate source differs from release commit");
  }
  return candidates;
}

export function verifyArchive(candidate, path, manifest) {
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error("Artifact must be a regular file");
  // Reject traversal and links before handing the archive to pnpm's extractor.
  const listed = spawnSync("tar", ["-tzf", path], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 30_000 });
  const verbose = spawnSync("tar", ["-tvzf", path], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 30_000 });
  if (listed.status !== 0 || verbose.status !== 0) throw new Error("Cannot inspect release archive");
  const paths = listed.stdout.trim().split("\n");
  if (paths.some(p => !p.startsWith("package/") || p.includes("\\") || p.split("/").includes(".."))
    || new Set(paths).size !== paths.length || verbose.stdout.trim().split("\n").some(line => !/^[d-]/.test(line))) {
    throw new Error("Unsafe release archive paths or links");
  }
  verifyPackedCandidate({ ...candidate, filename: basename(path) }, path, manifest);
}

export async function acquireArtifacts(candidates, manifests, directory, artifactDirectory, {
  transport = globalThis.fetch, checkPublished = verifyDependencySource, commit = currentCommit(),
} = {}) {
  const artifacts = new Map();
  for (const [index, candidate] of candidates.entries()) {
    let path;
    if (candidate.mode === "publish") {
      if (typeof candidate.filename !== "string" || basename(candidate.filename) !== candidate.filename
        || !candidate.filename.endsWith(".tgz")) throw new Error("Invalid publish artifact filename");
      path = join(artifactDirectory, candidate.filename);
    } else {
      const bytes = await boundedFetch(`${registry}${encodeURIComponent(candidate.name)}/${encodeURIComponent(candidate.version)}`, 2 * 1024 * 1024, transport);
      const metadata = JSON.parse(bytes);
      if (metadata.name !== candidate.name || metadata.version !== candidate.version || metadata.gitHead !== candidate.sourceCommit
        || metadata.dist?.integrity !== candidate.integrity || metadata.dist?.tarball !== canonicalTarball(candidate)) {
        throw new Error(`Registry candidate identity, integrity or URL mismatch: ${candidate.name}`);
      }
      const published = { exists: true, version: metadata.version, gitHead: metadata.gitHead, integrity: metadata.dist.integrity };
      assertLockedPublishedArtifact(candidate.name, candidate.version, published);
      checkPublished(candidate, published, commit);
      const archive = await boundedFetch(metadata.dist.tarball, 64 * 1024 * 1024, transport);
      if (digest(archive) !== candidate.integrity) throw new Error(`Registry archive integrity mismatch: ${candidate.name}`);
      path = join(directory, `registry-${index}.tgz`);
      writeFileSync(path, archive, { flag: "wx" });
    }
    verifyArchive(candidate, path, manifests.get(candidate.name));
    artifacts.set(candidate.name, { path, integrity: candidate.integrity });
  }
  return artifacts;
}

export function recheckArtifacts(candidates, manifests, artifacts) {
  for (const candidate of candidates) verifyArchive(candidate, artifacts.get(candidate.name).path, manifests.get(candidate.name));
}
