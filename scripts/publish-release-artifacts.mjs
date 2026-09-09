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
  assertLockedPublishedArtifact,
} from "./release-utils.mjs";
import { registry, root } from "./workspaces.mjs";
import { publishOrderedBatch, validateReleaseBatch, verifyPackedCandidate } from "./release-batch.mjs";

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

const candidates = validateReleaseBatch(manifest.candidates);
// Validate the entire batch before the first irreversible registry write.
for (const candidate of candidates) {
  if (candidate.mode === "publish") {
    if (candidate.sourceCommit !== commit) throw new Error(`Publish candidate is not from this checkout: ${candidate.name}`);
    verifyPackedCandidate(candidate, resolve(manifestPath, "..", candidate.filename));
  }
}

const publishWarnings = publishOrderedBatch(candidates, {
  publish(candidate) {
    const tarballPath = resolve(manifestPath, "..", candidate.filename);
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
      throw new Error((published.stderr || published.stdout).trim());
    }
  },
  verify(candidate) {
    const published = lookupWithPropagationRetry(candidate.name, candidate.version);
    if (!published.exists || published.gitHead !== candidate.sourceCommit) {
      throw new Error(`Dependency release is not registry-visible with the expected identity: ${candidate.name}`);
    }
    assertLockedPublishedArtifact(candidate.name, candidate.version, published);
    if (published.integrity !== candidate.integrity) {
      throw new Error(`Published integrity mismatch: ${candidate.name}`);
    }
  },
});

const releases = [];
const tagsToCreate = [];
const unresolved = [];
for (const candidate of candidates) {
  const candidateUnresolved = [];
  const published = lookupWithPropagationRetry(candidate.name, candidate.version);
  if (!published.exists) {
    candidateUnresolved.push(`${candidate.name}@${candidate.version} is not published`);
    unresolved.push(...candidateUnresolved);
    continue;
  }
  if (published.gitHead !== candidate.sourceCommit) {
    candidateUnresolved.push(
      `${candidate.name}@${candidate.version} has npm gitHead ${published.gitHead ?? "(missing)"}, expected ${candidate.sourceCommit}`,
    );
    unresolved.push(...candidateUnresolved);
    continue;
  }
  assertLockedPublishedArtifact(candidate.name, candidate.version, published);
  if (published.integrity !== candidate.integrity) {
    unresolved.push(`${candidate.name}@${candidate.version} has mismatched published integrity`);
    continue;
  }

  const distTags = lookupDistTags(candidate.name);
  if (distTags[candidate.distTag] !== candidate.version) {
    candidateUnresolved.push(
      `${candidate.name}@${candidate.version} is not assigned to npm dist-tag ${candidate.distTag}; fix it interactively`,
    );
  }
  if (candidate.prerelease && distTags.latest === candidate.version) {
    candidateUnresolved.push(
      `${candidate.name}@${candidate.version} is a prerelease but is also assigned to npm dist-tag latest`,
    );
  }

  const tagCommit = existingTagCommit(candidate.tag);
  if (tagCommit && tagCommit !== candidate.sourceCommit) {
    throw new Error(`tag ${candidate.tag} points to ${tagCommit}, expected ${candidate.sourceCommit}`);
  }
  if (candidateUnresolved.length > 0) {
    unresolved.push(...candidateUnresolved);
    continue;
  }

  releases.push({
    name: candidate.name,
    version: candidate.version,
    tag: candidate.tag,
    notes: candidate.notes,
    prerelease: candidate.prerelease === true,
  });
  if (!tagCommit) tagsToCreate.push({ tag: candidate.tag, sourceCommit: candidate.sourceCommit });
}

const ok =
  unresolved.length === 0
  && publishWarnings.length === 0
  && releases.length === candidates.length
  && releases.length > 0;

if (ok) {
  for (const { tag, sourceCommit } of tagsToCreate) {
    git(["tag", tag, sourceCommit]);
  }
}

const result = {
  schemaVersion: 1,
  commit,
  ok,
  releases,
  unresolved,
  publishWarnings,
};
writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);

for (const release of releases) console.log(`✓ reconciled ${release.tag}`);
for (const message of unresolved) console.error(`✗ ${message}`);
for (const warning of publishWarnings) {
  console.error(`! release step did not verify for ${warning.name}; registry state was reconciled afterward`);
}
if (!ok) {
  console.error("! npm release finalization is deferred until a clean recovery run; no new tags were created");
}
