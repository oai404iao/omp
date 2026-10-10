/**
 * Project a production dependency closure from the reviewed pnpm v9 lock.
 * Registry artifacts retain their exact URLs/hashes and peer-specific snapshots;
 * workspace dependencies are replaced with the packed artifacts, never links.
 */
export function isolatedConsumerLock(name, included, manifests, artifacts, sourceLock) {
  if (String(sourceLock.lockfileVersion) !== "9.0") throw new Error("Expected a pnpm v9 lockfile");
  const packages = {};
  const snapshots = {};
  const dependencies = {};
  const importerDependencies = {};
  const overrides = {};
  const locals = new Set(included);
  const hosts = new Map();
  const root = sourceLock.importers["."];
  const importerFor = pkg => sourceLock.importers[`pi-extensions/${pkg.split("/")[1]}`];
  const locked = (importer, dependency) => importer?.dependencies?.[dependency]
    ?? importer?.optionalDependencies?.[dependency] ?? importer?.devDependencies?.[dependency];
  const packageKey = snapshot => snapshot.split("(")[0];

  function visit(dependency, reference) {
    if (typeof reference !== "string" || /^(?:link:|file:|workspace:)/.test(reference)) {
      throw new Error(`Unpinned or linked external dependency: ${dependency}`);
    }
    // Alias references carry the real package name, rather than the import name.
    const key = sourceLock.snapshots[`${dependency}@${reference}`]
      ? `${dependency}@${reference}` : reference;
    if (snapshots[key]) return;
    const entry = sourceLock.packages[packageKey(key)];
    const snapshot = sourceLock.snapshots[key];
    if (!entry || !snapshot) throw new Error(`Missing locked dependency: ${dependency} -> ${reference}`);
    if (!entry.resolution?.integrity || entry.resolution.type || entry.resolution.directory) {
      throw new Error(`Unpinned or linked external dependency: ${key}`);
    }
    if (!entry.resolution.tarball?.startsWith("https://registry.npmjs.org/")) {
      throw new Error(`External dependency is not a locked registry artifact: ${key}`);
    }
    packages[packageKey(key)] = structuredClone(entry);
    snapshots[key] = structuredClone(snapshot);
    for (const [dep, ref] of Object.entries({ ...snapshot.dependencies, ...snapshot.optionalDependencies })) visit(dep, ref);
    for (const peer of Object.keys(entry.peerDependencies ?? {})) {
      if (!snapshot.dependencies?.[peer] && !snapshot.optionalDependencies?.[peer]
        && !entry.peerDependenciesMeta?.[peer]?.optional) {
        throw new Error(`Missing locked dependency: ${key} -> ${peer}`);
      }
    }
  }

  // Hoist the explicitly selected Pi host peers into the isolated consumer.
  for (const pkg of locals) {
    const manifest = manifests.get(pkg);
    const artifact = artifacts.get(pkg);
    if (!manifest || !artifact?.path || !artifact.integrity) throw new Error(`Missing packed workspace artifact: ${pkg}`);
    overrides[pkg] = `file:${artifact.path}`;
    for (const dependency of Object.keys(manifest.peerDependencies ?? {})) {
      if (locals.has(dependency)) continue;
      const entry = locked(root, dependency) ?? locked(importerFor(pkg), dependency);
      if (!entry) throw new Error(`Missing locked Pi host peer: ${dependency}`);
      if (hosts.has(dependency) && hosts.get(dependency).version !== entry.version) {
        throw new Error(`Conflicting locked Pi host peer: ${dependency}`);
      }
      hosts.set(dependency, entry);
    }
  }
  for (const [dependency, entry] of hosts) {
    visit(dependency, entry.version);
    const version = packageKey(entry.version);
    const specifier = version.includes("@") ? `npm:${version}` : version;
    dependencies[dependency] = specifier;
    importerDependencies[dependency] = { specifier, version: entry.version };
  }

  const localReferences = new Map();
  function localReference(pkg, visiting = new Set()) {
    if (localReferences.has(pkg)) return localReferences.get(pkg);
    if (visiting.has(pkg)) throw new Error(`Cyclic workspace peers: ${pkg}`);
    visiting.add(pkg);
    const peers = Object.keys(manifests.get(pkg).peerDependencies ?? {}).sort().map(peer => {
      const ref = locals.has(peer) ? localReference(peer, visiting) : hosts.get(peer).version;
      return `(${peer}@${ref})`;
    }).join("");
    visiting.delete(pkg);
    const reference = overrides[pkg] + peers;
    localReferences.set(pkg, reference);
    return reference;
  }
  for (const pkg of locals) {
    const manifest = manifests.get(pkg);
    const reference = localReference(pkg);
    dependencies[pkg] = overrides[pkg];
    importerDependencies[pkg] = { specifier: overrides[pkg], version: reference };
    const entry = { resolution: { integrity: artifacts.get(pkg).integrity, tarball: overrides[pkg] }, version: manifest.version };
    for (const field of ["engines", "os", "cpu", "libc", "peerDependencies", "peerDependenciesMeta"]) {
      if (manifest[field]) entry[field] = structuredClone(manifest[field]);
    }
    if (manifest.bin) entry.hasBin = true;
    packages[`${pkg}@${overrides[pkg]}`] = entry;
    const snapshot = {};
    for (const field of ["dependencies", "optionalDependencies"]) {
      for (const dependency of Object.keys(manifest[field] ?? {})) {
        let ref;
        if (manifests.has(dependency)) {
          if (!locals.has(dependency)) throw new Error(`Missing packed workspace dependency: ${pkg} -> ${dependency}`);
          ref = localReference(dependency);
        } else {
          ref = locked(importerFor(pkg), dependency)?.version;
          if (!ref) throw new Error(`Missing locked dependency: ${pkg} -> ${dependency}`);
          visit(dependency, ref);
        }
        (snapshot[field] ??= {})[dependency] = ref;
      }
    }
    for (const dependency of Object.keys(manifest.peerDependencies ?? {})) {
      if (snapshot.dependencies?.[dependency] || snapshot.optionalDependencies?.[dependency]) continue;
      const field = manifest.peerDependenciesMeta?.[dependency]?.optional ? "optionalDependencies" : "dependencies";
      (snapshot[field] ??= {})[dependency] = locals.has(dependency) ? localReference(dependency) : hosts.get(dependency).version;
    }
    snapshots[`${pkg}@${reference}`] = snapshot;
  }
  const manifest = { name, version: "1.0.0", private: true, type: "module", dependencies };
  const workspace = { autoInstallPeers: false, lockfileIncludeTarballUrl: true, overrides };
  const lock = {
    lockfileVersion: "9.0",
    settings: { ...sourceLock.settings, autoInstallPeers: false },
    overrides,
    importers: { ".": { dependencies: importerDependencies } },
    packages,
    snapshots,
  };
  return { manifest, workspace, lock };
}
