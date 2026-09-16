import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  currentCommit,
  existingTagCommit,
  git,
  lookupDistTags,
  lookupPublishedVersions,
  lockedPublishedArtifact,
  lookupPublishedVersion,
  npm,
  assertLockedPublishedArtifact,
} from "./release-utils.mjs";
import { registry, root } from "./workspaces.mjs";
import { publishOrderedBatch, validateReleaseBatch, verifyPackedCandidate } from "./release-batch.mjs";
import { hasInitialBootstrapLatestAlias, isInitialCodexBootstrap } from "./initial-codex-bootstrap.mjs";

const [manifestArgument, resultArgument] = process.argv.slice(2);
if (!manifestArgument || !resultArgument) {
  throw new Error("usage: publish-release-artifacts.mjs <manifest.json> <result.json>");
}

const manifestPath = resolve(root, manifestArgument);
const resultPath = resolve(root, resultArgument);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const commit = currentCommit();

function positiveMilliseconds(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

const propagationTimeoutMs = positiveMilliseconds("NPM_REGISTRY_PROPAGATION_TIMEOUT_MS", 180_000);
const propagationInitialDelayMs = positiveMilliseconds("NPM_REGISTRY_PROPAGATION_INITIAL_DELAY_MS", 2_000);
const propagationMaxDelayMs = positiveMilliseconds("NPM_REGISTRY_PROPAGATION_MAX_DELAY_MS", 15_000);
if (propagationInitialDelayMs > propagationMaxDelayMs) {
  throw new Error("NPM_REGISTRY_PROPAGATION_INITIAL_DELAY_MS must not exceed NPM_REGISTRY_PROPAGATION_MAX_DELAY_MS");
}

function wait(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

class RegistryPropagationPending extends Error {}

function lookupCandidateVersion(candidate) {
  try {
    return lookupPublishedVersion(candidate.name, candidate.version);
  } catch (error) {
    throw new RegistryPropagationPending(
      `npm metadata lookup failed for ${candidate.name}@${candidate.version}: ${String(error.message ?? error)}`,
    );
  }
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

function verifyCandidateTags(candidate) {
  const pending = [];
  const unresolved = [];
  let distTags;
  try {
    distTags = lookupDistTags(candidate.name);
  } catch (error) {
    throw new RegistryPropagationPending(
      `npm dist-tag lookup failed for ${candidate.name}: ${String(error.message ?? error)}`,
    );
  }
  if (distTags[candidate.distTag] !== candidate.version) {
    pending.push(
      `${candidate.name}@${candidate.version} is not assigned to npm dist-tag ${candidate.distTag}`,
    );
  }
  if (candidate.prerelease && distTags.latest === candidate.version) {
    let initialAlias = false;
    const locked = lockedPublishedArtifact(candidate.name, candidate.version);
    if (candidate.mode === "recover" && isInitialCodexBootstrap(candidate)
      && locked?.gitHead === candidate.sourceCommit && locked?.integrity === candidate.integrity) {
      try {
        initialAlias = hasInitialBootstrapLatestAlias(candidate, distTags, lookupPublishedVersions(candidate.name));
      } catch {
        unresolved.push(`Cannot verify initial bootstrap version history for ${candidate.name}`);
      }
    }
    if (!initialAlias) {
      unresolved.push(`${candidate.name}@${candidate.version} is a prerelease but is also assigned to npm dist-tag latest`);
    } else {
      console.log(`ℹ accepted locked first-bootstrap latest/next alias for ${candidate.name}@${candidate.version}`);
    }
  }
  return { pending, unresolved };
}

function verifyCandidateRegistryState(candidate) {
  const published = lookupCandidateVersion(candidate);
  if (!published.exists) {
    throw new RegistryPropagationPending(
      `Dependency release is not registry-visible with the expected identity: ${candidate.name}`,
    );
  }
  if (published.gitHead !== candidate.sourceCommit) {
    throw new Error(`Dependency release is not registry-visible with the expected identity: ${candidate.name}`);
  }
  assertLockedPublishedArtifact(candidate.name, candidate.version, published);
  if (published.integrity !== candidate.integrity) {
    throw new Error(`Published integrity mismatch: ${candidate.name}`);
  }
  const tagErrors = verifyCandidateTags(candidate);
  if (tagErrors.unresolved.length > 0) throw new Error(tagErrors.unresolved.join("; "));
  if (tagErrors.pending.length > 0) throw new RegistryPropagationPending(tagErrors.pending.join("; "));
}

function verifyNewlyPublishedCandidate(candidate) {
  const startedAt = Date.now();
  let attempt = 1;
  let delayMs = propagationInitialDelayMs;
  for (;;) {
    try {
      verifyCandidateRegistryState(candidate);
      if (attempt > 1) {
        console.log(
          `✓ npm registry converged for ${candidate.name}@${candidate.version} after ${attempt} attempts`,
        );
      }
      return;
    } catch (error) {
      if (!(error instanceof RegistryPropagationPending)) throw error;
      const elapsedMs = Date.now() - startedAt;
      const remainingMs = propagationTimeoutMs - elapsedMs;
      if (remainingMs <= 0) {
        throw new Error(
          `npm registry did not converge for ${candidate.name}@${candidate.version} within `
          + `${propagationTimeoutMs}ms: ${error.message}`,
        );
      }
      const nextDelayMs = Math.min(delayMs, remainingMs);
      console.log(
        `… waiting for npm registry propagation of ${candidate.name}@${candidate.version} `
        + `(attempt ${attempt}, retry in ${nextDelayMs}ms): ${error.message}`,
      );
      wait(nextDelayMs);
      delayMs = Math.min(delayMs * 2, propagationMaxDelayMs);
      attempt += 1;
    }
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
    if (candidate.mode === "publish") verifyNewlyPublishedCandidate(candidate);
    else verifyCandidateRegistryState(candidate);
  },
});

const releases = [];
const tagsToCreate = [];
const unresolved = [];
for (const candidate of candidates) {
  const candidateUnresolved = [];
  const published = lookupPublishedVersion(candidate.name, candidate.version);
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

  const tagErrors = verifyCandidateTags(candidate);
  candidateUnresolved.push(
    ...tagErrors.pending.map(message => `${message}; fix it interactively`),
    ...tagErrors.unresolved,
  );

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
  console.error(`! release step did not verify for ${warning.name}: ${warning.message}`);
}
if (!ok) {
  console.error("! npm release finalization is deferred until a clean recovery run; no new tags were created");
}
