import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const digest = bytes => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

function verifyConsumerCoverage(consumers, candidates) {
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
    assert.ok(consumer.requested.every(name => consumer.included.includes(name)), "requested candidate missing from consumer closure");
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

export function verifyConsumerReceipt(manifestPath, receiptPath) {
  const bytes = readFileSync(manifestPath);
  const manifest = JSON.parse(bytes);
  const receipt = JSON.parse(readFileSync(receiptPath));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.commit, manifest.commit);
  assert.equal(receipt.manifestIntegrity, digest(bytes), "release manifest differs from tested manifest");
  assert.equal(receipt.requestedPackage, manifest.requestedPackage ?? null);
  assert.ok(Array.isArray(manifest.candidates) && manifest.candidates.length > 0);
  assert.ok(Array.isArray(receipt.consumers) && receipt.consumers.length > 0);
  assert.equal(new Set(manifest.candidates.map(c => c.name)).size, manifest.candidates.length);
  verifyConsumerCoverage(receipt.consumers, manifest.candidates);
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
