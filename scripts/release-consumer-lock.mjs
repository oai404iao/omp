import { createRequire } from "node:module";
import { isolatedConsumerLock } from "./isolated-consumer-lock.mjs";

// Changesets already owns the workspace's release-time SemVer implementation.
const require = createRequire(import.meta.url);
const { satisfies } = createRequire(require.resolve("@changesets/cli/package.json"))("semver");
const locked = (importer, dependency) => importer?.dependencies?.[dependency]
  ?? importer?.optionalDependencies?.[dependency] ?? importer?.devDependencies?.[dependency];

export function releaseConsumerLock(name, included, manifests, artifacts, lock) {
  for (const pkg of included) {
    const manifest = manifests.get(pkg);
    const importer = lock.importers?.[`pi-extensions/${pkg.split("/").at(-1)}`];
    for (const [dependency, specifier] of Object.entries({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
      if (manifests.has(dependency)) continue;
      const entry = locked(importer, dependency);
      if (!entry || entry.specifier !== specifier) throw new Error(`Historical external lock prerequisite mismatch: ${pkg} -> ${dependency}`);
      if (!satisfies(entry.version.split("(")[0], specifier)) throw new Error(`Locked external version does not satisfy historical dependency: ${dependency}`);
    }
    for (const [peer, range] of Object.entries(manifest.peerDependencies ?? {})) {
      if (manifests.has(peer)) {
        if (!included.has(peer) || !satisfies(manifests.get(peer).version, range)) throw new Error(`Historical workspace peer mismatch: ${peer}`);
        continue;
      }
      const entry = locked(lock.importers?.["."], peer) ?? locked(importer, peer);
      if (!entry || !satisfies(entry.version.split("(")[0], range)) throw new Error(`Historical host peer lock prerequisite mismatch: ${peer}`);
    }
  }
  return isolatedConsumerLock(name, included, manifests, artifacts, lock);
}

export function candidateClosure(requested, manifests) {
  const included = new Set();
  function visit(name) {
    if (included.has(name)) return;
    const manifest = manifests.get(name);
    if (!manifest) throw new Error(`Missing candidate dependency: ${name}`);
    included.add(name);
    for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
      if (manifests.has(dependency)) visit(dependency);
    }
  }
  requested.forEach(visit);
  return included;
}

export function releaseConsumerCases(candidates, manifests) {
  const cases = candidates.map(candidate => ({ label: candidate.name.split("/").at(-1), requested: [candidate.name] }));
  if (candidates.length > 1) cases.push({ label: "combined", requested: candidates.map(c => c.name) });
  return cases.map(item => ({ ...item, included: candidateClosure(item.requested, manifests) }));
}
