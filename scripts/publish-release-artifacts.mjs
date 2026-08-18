import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  currentCommit,
  existingTagCommit,
  git,
  lookupDistTags,
  lookupPublishedVersion,
  npm,
  sha512,
} from "./release-utils.mjs";
import { registry, root } from "./workspaces.mjs";

const [manifestArgument, resultArgument] = process.argv.slice(2);
if (!manifestArgument || !resultArgument) {
  throw new Error("usage: publish-release-artifacts.mjs <manifest.json> <result.json>");
}

const manifestPath = resolve(root, manifestArgument);
const resultPath = resolve(root, resultArgument);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const commit = currentCommit();

function wait(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function lookupWithPropagationRetry(name, version) {
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const published = lookupPublishedVersion(name, version);
    if (published.exists || attempt === 6) return published;
    wait(2_000);
  }
  return { exists: false };
}

if (manifest.schemaVersion !== 1 || manifest.commit !== commit) {
  throw new Error(`release artifact commit ${String(manifest.commit)} does not match checkout ${commit}`);
}
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== commit) {
  throw new Error(`checkout ${commit} does not match GITHUB_SHA ${process.env.GITHUB_SHA}`);
}
if (manifest.registry !== registry || !Array.isArray(manifest.candidates)) {
  throw new Error("release artifact manifest is malformed or targets another registry");
}

const publishWarnings = [];
for (const candidate of manifest.candidates) {
  if (candidate.mode !== "publish") continue;

  const tarballPath = resolve(manifestPath, "..", candidate.filename);
  if (sha512(tarballPath) !== candidate.integrity) {
    throw new Error(`artifact integrity mismatch for ${candidate.filename}`);
  }

  const published = spawnSync(
    npm,
    [
      "publish",
      tarballPath,
      "--ignore-scripts",
      "--access",
      "public",
      "--provenance",
      "--tag",
      candidate.distTag,
      "--registry",
      registry,
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (published.status !== 0) {
    publishWarnings.push({
      name: candidate.name,
      message: (published.stderr || published.stdout).trim(),
    });
    break;
  }
}

const releases = [];
const unresolved = [];
for (const candidate of manifest.candidates) {
  const published = lookupWithPropagationRetry(candidate.name, candidate.version);
  if (!published.exists) {
    unresolved.push(`${candidate.name}@${candidate.version} is not published`);
    continue;
  }
  if (published.gitHead !== candidate.sourceCommit) {
    unresolved.push(
      `${candidate.name}@${candidate.version} has npm gitHead ${published.gitHead ?? "(missing)"}, expected ${candidate.sourceCommit}`,
    );
    continue;
  }

  const distTags = lookupDistTags(candidate.name);
  if (distTags[candidate.distTag] !== candidate.version) {
    unresolved.push(
      `${candidate.name}@${candidate.version} is not assigned to npm dist-tag ${candidate.distTag}; fix it interactively`,
    );
  }
  if (candidate.prerelease && distTags.latest === candidate.version) {
    unresolved.push(
      `${candidate.name}@${candidate.version} is a prerelease but is also assigned to npm dist-tag latest`,
    );
  }

  const tagCommit = existingTagCommit(candidate.tag);
  if (tagCommit && tagCommit !== candidate.sourceCommit) {
    throw new Error(`tag ${candidate.tag} points to ${tagCommit}, expected ${candidate.sourceCommit}`);
  }
  if (!tagCommit) git(["tag", candidate.tag, candidate.sourceCommit]);

  releases.push({
    name: candidate.name,
    version: candidate.version,
    tag: candidate.tag,
    notes: candidate.notes,
    prerelease: candidate.prerelease === true,
  });
}

const result = {
  schemaVersion: 1,
  commit,
  ok: unresolved.length === 0 && releases.length > 0,
  releases,
  unresolved,
  publishWarnings,
};
writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);

for (const release of releases) console.log(`✓ reconciled ${release.tag}`);
for (const message of unresolved) console.error(`✗ ${message}`);
for (const warning of publishWarnings) {
  console.error(`! npm publish reported an error for ${warning.name}; registry state was reconciled afterward`);
}
