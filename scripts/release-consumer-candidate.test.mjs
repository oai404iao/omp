import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalTarball, digest } from "./release-consumer-artifacts.mjs";
import { run } from "./release-consumer-install.mjs";
import { verifyConsumerReceipt } from "./release-consumer-receipt.mjs";
import { verifyReleaseInstallations } from "./verify-release-installations.mjs";
import { registry } from "./workspaces.mjs";

test("target archive and historical registry dependency really install, load and produce a complete receipt despite changed checkout code", async () => {
  const parent = join(homedir(), ".local/state/agents/tmp"); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, "release-historical-candidate-test-"));
  const commit = "a".repeat(40), historicalCommit = "b".repeat(40);
  const dependencyName = "@oai404iao/pi-codex-runtime", targetName = "@oai404iao/pi-telegram-notify";
  const dependency = { name: dependencyName, version: "1.0.0", type: "module",
    exports: { ".": "./index.ts", "./subagent-inline": "./inline.ts" },
    peerDependencies: { "@earendil-works/pi-coding-agent": ">=1.2.0" } };
  const target = { name: targetName, version: "1.0.0", type: "module", dependencies: { [dependencyName]: "1.0.0" },
    peerDependencies: dependency.peerDependencies, pi: { extensions: ["./index.ts"] } };
  const manifests = new Map([[dependencyName, dependency], [targetName, target]]);
  const entries = [dependency, target].map(manifest => ({ name: manifest.name,
    directory: `pi-extensions/${manifest.name.split("/").at(-1)}`, releaseStatus: "publishable" }));
  const archive = (manifest, sourceCommit, files, label) => {
    const path = join(directory, label); mkdirSync(join(path, "package"), { recursive: true });
    writeFileSync(join(path, "package/package.json"), JSON.stringify({ ...manifest, gitHead: sourceCommit }));
    for (const [name, content] of Object.entries(files)) writeFileSync(join(path, "package", name), content);
    const tarball = join(directory, `${label}.tgz`);
    assert.equal(spawnSync("tar", ["-czf", tarball, "package/"], { cwd: path }).status, 0);
    return tarball;
  };
  const dependencyArchive = archive(dependency, historicalCommit, {
    "index.ts": `export function getCodexBroker() {}
export function addPackageTool() {}
export function ensureCodexServices() {}
export const CODEX_BROKER_CHANNEL = "@oai404iao/pi-codex:broker";
export const CODEX_RUNTIME_VERSION = "1.0.0";
export const historicalPayload = "immutable registry payload";`,
    "inline.ts": `export const CODEX_IDENTITY_CUSTOM_TYPE = "fixture";
export function createCodexSubagentInlineExtension() {}`,
  }, "historical-runtime");
  const targetArchive = archive(target, commit, { "index.ts": `
import { historicalPayload } from "@oai404iao/pi-codex-runtime";
if (historicalPayload !== "immutable registry payload") throw new Error("wrong dependency payload");
export default pi => pi.registerCommand("telegram-notify", { description: "fixture", handler: async () => {} });`,
  }, "target");
  // The checkout keeps the exact dependency contract but has unreleased throwing code.
  for (const entry of entries) {
    const path = join(directory, "checkout", entry.directory); mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "package.json"), JSON.stringify(manifests.get(entry.name)));
    writeFileSync(join(path, "index.ts"), `throw new Error("unreleased checkout must never ship");`);
  }
  const identity = (manifest, mode, sourceCommit, tarball) => ({ name: manifest.name, version: manifest.version,
    directory: entries.find(entry => entry.name === manifest.name).directory, tag: `${manifest.name}@${manifest.version}`,
    prerelease: false, distTag: "latest", mode, sourceCommit, integrity: digest(readFileSync(tarball)) });
  const depCandidate = identity(dependency, "verify", historicalCommit, dependencyArchive);
  const targetCandidate = { ...identity(target, "publish", commit, targetArchive), filename: "target.tgz" };
  const manifest = { schemaVersion: 1, commit, registry, requestedPackage: targetName, candidates: [depCandidate, targetCandidate] };
  const manifestPath = join(directory, "manifest.json"); writeFileSync(manifestPath, JSON.stringify(manifest));
  const calls = [];
  const receipt = await verifyReleaseInstallations(manifestPath, {
    validation: { commit, entries, env: {}, requestedPackage: targetName,
      manifestFor: entry => JSON.parse(readFileSync(join(directory, "checkout", entry.directory, "package.json"))) },
    historicalManifest: candidate => {
      assert.equal(candidate.sourceCommit, candidate.name === dependencyName ? historicalCommit : commit);
      return manifests.get(candidate.name);
    },
    acquisition: { commit, checkPublished: (candidate, published, source) => {
      assert.equal(candidate.name, dependencyName); assert.equal(published.gitHead, historicalCommit); assert.equal(source, commit);
    }, transport: async url => {
      calls.push(url);
      if (url === `${registry}${encodeURIComponent(dependencyName)}/1.0.0`) return Response.json({
        name: dependencyName, version: "1.0.0", gitHead: historicalCommit,
        dist: { integrity: depCandidate.integrity, tarball: canonicalTarball(depCandidate) },
      });
      assert.equal(url, canonicalTarball(depCandidate));
      return new Response(readFileSync(dependencyArchive));
    } },
    runner: (command, args, cwd, env) => {
      assert.ok(!args.includes("pack"), "verification must never pack checkout dependency sources");
      return run(command, args, cwd, env);
    },
  });
  assert.deepEqual(calls, [`${registry}${encodeURIComponent(dependencyName)}/1.0.0`, canonicalTarball(depCandidate)]);
  assert.equal(receipt.consumers.length, 3);
  assert.deepEqual(receipt.consumers.find(consumer => consumer.label === "combined").included.sort(), [dependencyName, targetName].sort());
  assert.deepEqual(verifyConsumerReceipt(manifestPath, join(directory, "consumer-verification.json")), receipt);
  assert.equal(receipt.artifacts.find(artifact => artifact.name === dependencyName).integrity, digest(readFileSync(dependencyArchive)));
  assert.equal(receipt.artifacts.find(artifact => artifact.name === targetName).integrity, digest(readFileSync(targetArchive)));
});
