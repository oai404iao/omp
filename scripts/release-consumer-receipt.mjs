import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactIdentity, compatibilityCases } from "./release-consumer-compatibility.mjs";
import { latestConsumerEntries } from "./release-consumer-compatibility-history.mjs";
import { candidateClosure } from "./release-consumer-lock.mjs";
import { assertLockedPublishedArtifact } from "./release-utils.mjs";
import { historicalManifest, targetedReleaseWorkspaces } from "./targeted-release.mjs";
import { workspaces } from "./workspaces.mjs";

const digest = bytes => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

function verifyConsumerCoverage(consumers, candidates, manifests) {
  const names = candidates.map(candidate => candidate.name);
  const known = new Set(names);
  const labels = new Set();
  assert.equal(consumers.length, names.length + (names.length > 1 ? 1 : 0), "receipt must cover every standalone candidate and the combined batch");
  for (const consumer of consumers) {
    assert.equal(typeof consumer.label, "string");
    assert.ok(consumer.label.length > 0 && !labels.has(consumer.label), "consumer labels must be unique");
    labels.add(consumer.label);
    for (const field of ["included", "requested"]) {
      const list = consumer[field];
      assert.ok(Array.isArray(list) && list.length > 0, `consumer ${field} must be a nonempty array`);
      assert.equal(new Set(list).size, list.length, `consumer ${field} contains duplicates`);
      assert.ok(list.every(name => typeof name === "string" && known.has(name)), `consumer ${field} contains unknown candidates`);
    }
    assert.deepEqual([...consumer.included].sort(), [...candidateClosure(consumer.requested, manifests)].sort(), "installed closure must match source manifest");
  }
  for (const name of names) {
    const standalone = consumers.find(consumer => consumer.label === name.split("/").at(-1));
    assert.ok(standalone, `missing standalone consumer: ${name}`);
    assert.deepEqual(standalone.requested, [name], "standalone consumer must request exactly its candidate");
  }
  if (names.length > 1) {
    const combined = consumers.find(consumer => consumer.label === "combined");
    assert.ok(combined, "missing combined batch consumer");
    for (const field of ["included", "requested"]) assert.deepEqual([...combined[field]].sort(), [...names].sort());
  }
}

// Reconstruct the obligations from immutable sources, without consulting mutable registry tags in the write job.
function verifyCompatibilityCoverage(evidence, { candidates, commit }, entries, source, inventory) {
  const expectedLatest = inventory(candidates, entries, commit).map(e => e.name).sort();
  assert.deepEqual(evidence.latest.map(c => c.name).sort(), expectedLatest, "receipt latest consumer inventory is incomplete");
  const known = new Map();
  function inspect(id) {
    const { name, version, sourceCommit, integrity } = id;
    const key = `${name}@${version}`;
    if (!known.has(key)) {
      const entry = entries.find(e => e.name === name && e.releaseStatus === "publishable");
      assert.ok(entry, `unknown compatibility artifact ${key}`);
      assert.match(sourceCommit, /^[0-9a-f]{40,64}$/i);
      assert.match(integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
      assertLockedPublishedArtifact(name, version, { gitHead: sourceCommit, integrity });
      const manifest = source({ ...artifactIdentity(id), tag: key, directory: entry.directory }, commit);
      known.set(key, { candidate: artifactIdentity(id), manifest });
    }
    assert.deepEqual(artifactIdentity(id), known.get(key).candidate, `inconsistent artifact identity: ${key}`);
    return known.get(key);
  }
  const latest = new Map(evidence.latest.map(id => [id.name, inspect(id)]));
  const manifests = new Map(candidates.map(c => [c.name, inspect(c).manifest]));
  const plans = compatibilityCases(candidates, manifests, latest, entries);
  assert.equal(evidence.checks.length, plans.length);
  for (const plan of plans) {
    const { artifacts, status, ...recorded } = evidence.checks.find(c => c.label === plan.label) ?? {};
    assert.deepEqual(recorded, plan, `missing or invalid compatibility case ${plan.label}`);
    if (plan.excluded) {
      assert.equal(status, "outside-declared-range"); assert.equal(artifacts, undefined); continue;
    }
    assert.equal(status, "installed");
    const group = new Map(artifacts.map(id => [id.name, inspect(id)]));
    assert.deepEqual(group.get(plan.subject)?.candidate, artifactIdentity(candidates.find(c => c.name === plan.subject)));
    for (const [name, floor] of Object.entries(plan.floors ?? {})) assert.equal(group.get(name)?.candidate.version, floor);
    if (!plan.floors) assert.deepEqual(group.get(plan.requested)?.candidate, latest.get(plan.requested).candidate);
    const closure = targetedReleaseWorkspaces(plan.requested, entries, e => group.get(e.name)?.manifest);
    assert.deepEqual(artifacts.map(c => c.name).sort(), closure.map(e => e.name).sort());
  }
  return manifests;
}

export function verifyConsumerReceipt(manifestPath, receiptPath, { entries = workspaces, source = historicalManifest, inventory = latestConsumerEntries } = {}) {
  const bytes = readFileSync(manifestPath);
  const manifest = JSON.parse(bytes);
  const receipt = JSON.parse(readFileSync(receiptPath));
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(receipt.schemaVersion, 2);
  assert.equal(receipt.commit, manifest.commit);
  assert.equal(receipt.manifestIntegrity, digest(bytes), "release manifest differs from tested manifest");
  assert.deepEqual(receipt.requestedPackages, manifest.requestedPackages);
  assert.ok(Array.isArray(manifest.candidates) && manifest.candidates.length > 0);
  assert.ok(Array.isArray(receipt.consumers) && receipt.consumers.length > 0);
  assert.equal(new Set(manifest.candidates.map(c => c.name)).size, manifest.candidates.length);
  const manifests = verifyCompatibilityCoverage(receipt.compatibility, manifest, entries, source, inventory);
  verifyConsumerCoverage(receipt.consumers, manifest.candidates, manifests);
  const expected = manifest.candidates.map(({ name, version, sourceCommit, integrity, mode, filename }) =>
    ({ name, version, sourceCommit, integrity, mode, ...(filename ? { filename } : {}) }));
  assert.ok(Array.isArray(receipt.artifacts));
  const byName = (a, b) => a.name.localeCompare(b.name);
  assert.deepEqual([...receipt.artifacts].sort(byName), expected.sort(byName), "receipt candidate set differs from release manifest");
  for (const candidate of manifest.candidates) {
    assert.match(candidate.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
    if (candidate.mode !== "publish") continue;
    assert.equal(basename(candidate.filename), candidate.filename);
    assert.ok(candidate.filename.endsWith(".tgz"));
    const path = join(dirname(manifestPath), candidate.filename);
    assert.ok(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink());
    assert.equal(digest(readFileSync(path)), candidate.integrity, `tested publish archive changed: ${candidate.name}`);
  }
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw new Error("usage: release-consumer-receipt.mjs <manifest.json> <consumer-verification.json>");
  verifyConsumerReceipt(resolve(process.argv[2]), resolve(process.argv[3]));
  console.log("✓ immutable release consumer receipt and publish archive hashes verified");
}
