import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  currentCommit,
  existingTagCommit,
  git,
  lockedPublishedArtifact,
  lookupPublishedVersion,
  npm,
  assertLockedPublishedArtifact,
} from "./release-utils.mjs";
import { registry, root } from "./workspaces.mjs";
import { validateReleaseBatch, verifyPackedCandidate } from "./release-batch.mjs";
import { hasInitialBootstrapLatestAlias, isInitialCodexBootstrap } from "./initial-codex-bootstrap.mjs";
import { verifyDependencySource } from "./targeted-release.mjs";
import { waitForRegistryVisibility, RegistryVisibilityPending } from "./registry-visibility.mjs";

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

const propagationTimeoutMs = positiveMilliseconds("NPM_REGISTRY_PROPAGATION_TIMEOUT_MS", 1_800_000);
const propagationInitialDelayMs = positiveMilliseconds("NPM_REGISTRY_PROPAGATION_INITIAL_DELAY_MS", 5_000);
const propagationMaxDelayMs = positiveMilliseconds("NPM_REGISTRY_PROPAGATION_MAX_DELAY_MS", 30_000);
if (propagationInitialDelayMs > propagationMaxDelayMs) {
  throw new Error("NPM_REGISTRY_PROPAGATION_INITIAL_DELAY_MS must not exceed NPM_REGISTRY_PROPAGATION_MAX_DELAY_MS");
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

const requestedPackage = process.env.RELEASE_PACKAGE || undefined;
if ((manifest.requestedPackage ?? undefined) !== requestedPackage) {
  throw new Error("release artifact requestedPackage does not match RELEASE_PACKAGE");
}
const candidates = validateReleaseBatch(manifest.candidates, undefined, undefined, requestedPackage);
// Validate the entire batch before the first irreversible registry write.
for (const candidate of candidates) {
  if (candidate.mode === "publish") {
    if (candidate.sourceCommit !== commit) throw new Error(`Publish candidate is not from this checkout: ${candidate.name}`);
    verifyPackedCandidate(candidate, resolve(manifestPath, "..", candidate.filename));
  }
  if (candidate.mode === "verify") {
    verifyDependencySource(candidate, lookupPublishedVersion(candidate.name, candidate.version), commit);
  }
}

function verifyCandidateTags(candidate, metadata) {
  const pending = [];
  const unresolved = [];
  const distTags = metadata.distTags;
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
        initialAlias = hasInitialBootstrapLatestAlias(candidate, distTags, metadata.versions);
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

const receipts = [];
const verified = new Set();
const publishWarnings = [];
let pendingVisibility = false;
function saveResult(extra = {}) {
  writeFileSync(resultPath, `${JSON.stringify({ schemaVersion: 1, commit, ok: false,
    releases: [], unresolved: [], publishWarnings, receipts, ...extra }, null, 2)}\n`);
}
saveResult();
for (const candidate of candidates) {
  try {
    const tagCommit = existingTagCommit(candidate.tag);
    if (tagCommit && tagCommit !== candidate.sourceCommit) {
      throw new Error(`tag ${candidate.tag} points to ${tagCommit}, expected ${candidate.sourceCommit}`);
    }
    if (candidate.mode === "publish" && process.env.RELEASE_VERIFY_ONLY !== "true") {
      const tarballPath = resolve(manifestPath, "..", candidate.filename);
      const published = spawnSync(
        npm,
        [
          "publish",
          tarballPath,
          "--ignore-scripts",
          "--dry-run=false",
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
        throw new Error((published.stderr || published.stdout || published.error?.message || "npm publish failed").trim());
      }
      // Keep npm's receipt visible; exit zero alone does not establish a registry write.
      if (published.stdout) process.stdout.write(published.stdout);
      if (published.stderr) process.stderr.write(published.stderr);

      receipts.push({ name: candidate.name, version: candidate.version, registry,
        sourceCommit: candidate.sourceCommit, integrity: candidate.integrity,
        runId: process.env.GITHUB_RUN_ID ?? null, acceptedAt: new Date().toISOString(), state: "accepted" });
      saveResult();
      if (process.env.GITHUB_STEP_SUMMARY) {
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\nAccepted npm upload (not yet install-verified): \`${JSON.stringify(receipts.at(-1))}\`\n`);
      }
      console.log(`accepted ${candidate.name}@${candidate.version}; receipt: ${resultPath}`);
    }
    await waitForRegistryVisibility(candidate, {
      registry, timeoutMs: propagationTimeoutMs,
      initialDelayMs: propagationInitialDelayMs, maxDelayMs: propagationMaxDelayMs,
      warning: message => console.warn(`::warning::${message}; run ${process.env.GITHUB_RUN_ID ?? "local"}; receipt ${resultPath}`),
      log: message => console.log(message),
      verify(metadata) {
        assertLockedPublishedArtifact(candidate.name, candidate.version, metadata);
        if (candidate.mode === "verify") return;
        const errors = verifyCandidateTags(candidate, metadata);
        if (errors.unresolved.length) throw new Error(errors.unresolved.join("; "));
        // Historical recovery never moves latest/next backwards.
        if (candidate.mode === "publish" && process.env.RELEASE_VERIFY_ONLY !== "true" && errors.pending.length) {
          throw new RegistryVisibilityPending(errors.pending.join("; "));
        }
      },
    });
    verified.add(candidate.name);
    const receipt = receipts.find(r => r.name === candidate.name);
    if (receipt) { receipt.state = "verified"; receipt.verifiedAt = new Date().toISOString(); }
    saveResult();
  } catch (error) {
    pendingVisibility = error instanceof RegistryVisibilityPending;
    const receipt = receipts.find(r => r.name === candidate.name);
    if (receipt && pendingVisibility) receipt.state = "pending-visibility";
    publishWarnings.push({ name: candidate.name, message: String(error.message ?? error),
      state: pendingVisibility ? "pending-visibility" : "failed" });
    saveResult({ state: pendingVisibility ? "pending-visibility" : "failed" });
    break;
  }
}

const releases = [];
const tagsToCreate = [];
const unresolved = [];
for (const candidate of candidates) {
  if (!verified.has(candidate.name)) {
    unresolved.push(`${candidate.name}@${candidate.version} is not verified`);
    continue;
  }
  if (candidate.mode === "verify") continue;
  const tagCommit = existingTagCommit(candidate.tag);
  if (tagCommit && tagCommit !== candidate.sourceCommit) {
    throw new Error(`tag ${candidate.tag} points to ${tagCommit}, expected ${candidate.sourceCommit}`);
  }

  releases.push({
    name: candidate.name,
    version: candidate.version,
    tag: candidate.tag,
    sourceCommit: candidate.sourceCommit,
    notes: candidate.notes,
    prerelease: candidate.prerelease === true,
  });
  if (!tagCommit) tagsToCreate.push({ tag: candidate.tag, sourceCommit: candidate.sourceCommit });
}

const ok =
  unresolved.length === 0
  && publishWarnings.length === 0
  && releases.length === candidates.filter(candidate => candidate.mode !== "verify").length
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
  receipts,
  state: ok ? "verified" : pendingVisibility ? "pending-visibility" : "failed",
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
