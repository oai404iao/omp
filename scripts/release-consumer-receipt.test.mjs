import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { digest } from "./release-consumer-artifacts.mjs";
import { verifyConsumerReceipt } from "./release-consumer-receipt.mjs";

test("protected no-network receipt validator rejects candidate, manifest and publish-byte mutation", () => {
  const parent = join(homedir(), ".local/state/agents/tmp"); mkdirSync(parent, { recursive: true });
  for (const mutate of [false, "archive", "manifest", "candidate", "commit"]) {
    const directory = mkdtempSync(join(parent, "release-receipt-test-"));
    const manifestPath = join(directory, "manifest.json"), receiptPath = join(directory, "consumer-verification.json");
    const tarball = join(directory, "fixture.tgz"); writeFileSync(tarball, "tested bytes");
    const candidate = { name: "@oai404iao/fixture", version: "1.0.0", sourceCommit: "a".repeat(40),
      integrity: digest(readFileSync(tarball)), mode: "publish", filename: "fixture.tgz" };
    const manifest = { schemaVersion: 1, commit: candidate.sourceCommit, candidates: [candidate] };
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const receipt = { schemaVersion: 1, commit: manifest.commit, manifestIntegrity: digest(readFileSync(manifestPath)),
      requestedPackage: null, artifacts: [candidate], consumers: [{ label: "fixture", requested: [candidate.name], included: [candidate.name] }] };
    if (mutate === "candidate") receipt.artifacts = [];
    if (mutate === "commit") receipt.commit = "b".repeat(40);
    writeFileSync(receiptPath, JSON.stringify(receipt));
    if (mutate === "archive") writeFileSync(tarball, "different bytes");
    if (mutate === "manifest") writeFileSync(manifestPath, JSON.stringify({ ...manifest, requestedPackage: candidate.name }));
    if (mutate) assert.throws(() => verifyConsumerReceipt(manifestPath, receiptPath));
    else assert.equal(verifyConsumerReceipt(manifestPath, receiptPath).commit, manifest.commit);
  }
});

test("receipt consumer coverage requires unique complete standalone and combined candidate cases", () => {
  const parent = join(homedir(), ".local/state/agents/tmp"); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, "release-receipt-coverage-test-"));
  const manifestPath = join(directory, "manifest.json"), receiptPath = join(directory, "consumer-verification.json");
  const names = ["@oai404iao/target", "@oai404iao/dependency"];
  const candidates = names.map(name => ({ name, version: "1.0.0", sourceCommit: "a".repeat(40),
    integrity: digest(Buffer.from(name)), mode: "recover" }));
  const manifest = { schemaVersion: 1, commit: "a".repeat(40), requestedPackage: names[0], candidates };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const good = { schemaVersion: 1, commit: manifest.commit, manifestIntegrity: digest(readFileSync(manifestPath)),
    requestedPackage: manifest.requestedPackage, artifacts: candidates,
    consumers: [
      { label: "target", requested: [names[0]], included: names },
      { label: "dependency", requested: [names[1]], included: [names[1]] },
      { label: "combined", requested: names, included: names },
    ] };
  writeFileSync(receiptPath, JSON.stringify(good));
  assert.doesNotThrow(() => verifyConsumerReceipt(manifestPath, receiptPath));
  for (const mutate of [r => r.consumers = [{}], r => r.consumers.pop(),
    r => r.consumers[1].label = "target", r => r.consumers[0].requested = [],
    r => r.consumers[0].included.push("@oai404iao/unknown"),
    r => r.consumers[1].included.push(names[1]),
    r => r.consumers[1].included = [names[0]],
    r => r.consumers[1].requested = [names[0]],
    r => r.consumers[2].requested = [names[0]],
    r => r.consumers[2].included = [names[0]],
    r => r.consumers[2].label = "unexpected"]) {
    const bad = structuredClone(good); mutate(bad);
    writeFileSync(receiptPath, JSON.stringify(bad));
    assert.throws(() => verifyConsumerReceipt(manifestPath, receiptPath));
  }
});
