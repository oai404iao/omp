import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateReleaseBatch } from "./release-batch.mjs";
import { readPnpmLock } from "./pnpm-lock.mjs";
import { acquireArtifacts, digest, historicalManifest, recheckArtifacts, validateManifest } from "./release-consumer-artifacts.mjs";
import { installConsumers } from "./release-consumer-install.mjs";
import { root, workspaces } from "./workspaces.mjs";

export async function verifyReleaseInstallations(manifestPath, options = {}) {
  manifestPath = resolve(manifestPath);
  const original = readFileSync(manifestPath);
  const manifest = JSON.parse(original);
  const candidates = validateManifest(manifest, options.validation);
  const manifests = new Map(candidates.map(candidate => [candidate.name, (options.historicalManifest ?? historicalManifest)(candidate)]));
  // Validate the actual historical contracts as well as the checkout selection.
  validateReleaseBatch(candidates, options.validation?.entries ?? workspaces,
    entry => manifests.get(entry.name) ?? options.validation?.manifestFor?.(entry), manifest.requestedPackage ?? undefined);
  const scratchRoot = join(homedir(), ".local/state/agents/tmp");
  mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(scratchRoot, "release-consumers-"));
  const artifacts = await acquireArtifacts(candidates, manifests, directory, dirname(manifestPath), options.acquisition);
  const consumers = (options.install ?? installConsumers)(candidates, manifests, artifacts,
    options.lock ?? readPnpmLock(join(root, "pnpm-lock.yaml")), directory, options.runner);
  recheckArtifacts(candidates, manifests, artifacts);
  if (!readFileSync(manifestPath).equals(original)) throw new Error("Release manifest changed during consumer verification");
  const receipt = { schemaVersion: 1, commit: manifest.commit, manifestIntegrity: digest(original),
    requestedPackage: manifest.requestedPackage ?? null,
    artifacts: candidates.map(({ name, version, sourceCommit, integrity, mode, filename }) =>
      ({ name, version, sourceCommit, integrity, mode, ...(filename ? { filename } : {}) })), consumers };
  writeFileSync(join(dirname(manifestPath), "consumer-verification.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error("usage: verify-release-installations.mjs <manifest.json>");
  const receipt = await verifyReleaseInstallations(resolve(root, process.argv[2]));
  console.log(`✓ release ${receipt.commit}: ${receipt.artifacts.length} immutable artifacts, ${receipt.consumers.length} isolated frozen offline consumers; receipt consumer-verification.json`);
}
