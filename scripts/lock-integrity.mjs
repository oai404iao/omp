function registryArtifacts(lock) {
  return Object.entries(lock.packages ?? {}).flatMap(([path, entry]) => {
    if (entry.resolution?.directory || /@(?:file|link|workspace):/.test(path)) return [];
    const version = path.slice(path.lastIndexOf("@") + 1);
    const resolution = entry.resolution;
    if (!resolution?.tarball) throw new Error(`Missing registry artifact tarball: ${path}`);
    return [{ path, version, resolved: resolution.tarball, resolution }];
  });
}

/** Preserve reviewed hashes using exact tarball URL and version, never a range. */
export function preserveRegistryIntegrity(previous, next, reviewedArtifacts = []) {
  const known = new Map();
  const previousArtifacts = registryArtifacts(previous).map(entry => ({
    ...entry, integrity: entry.resolution.integrity,
  }));
  for (const entry of [...previousArtifacts, ...reviewedArtifacts]) {
    if (!entry.resolved || !entry.integrity) continue;
    const key = `${entry.resolved}\0${entry.version}`;
    if (known.has(key) && known.get(key) !== entry.integrity) throw new Error("Conflicting locked artifact integrity");
    known.set(key, entry.integrity);
  }
  const artifacts = registryArtifacts(next);
  // Reuse evidence for the same artifact even when it has another package key.
  for (const entry of artifacts) {
    if (!entry.resolution.integrity) continue;
    const key = `${entry.resolved}\0${entry.version}`;
    if (!known.has(key)) known.set(key, entry.resolution.integrity);
  }
  for (const entry of artifacts) {
    const expected = known.get(`${entry.resolved}\0${entry.version}`);
    if (expected && entry.resolution.integrity && entry.resolution.integrity !== expected) {
      throw new Error(`Registry artifact integrity changed without a new identity: ${entry.path}`);
    }
    if (!entry.resolution.integrity && expected) entry.resolution.integrity = expected;
    if (!entry.resolution.integrity) throw new Error(`Missing reviewed artifact integrity: ${entry.path}`);
  }
  return next;
}
