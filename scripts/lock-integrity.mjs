/** npm may omit hashes re-imported from a dependency's shrinkwrap. Never lose a reviewed hash. */
export function preserveRegistryIntegrity(previous, next) {
  const known = new Map();
  for (const entry of Object.values(previous.packages)) {
    if (!entry.resolved || !entry.integrity || entry.link) continue;
    const key = `${entry.resolved}\0${entry.version}`;
    if (known.has(key) && known.get(key) !== entry.integrity) throw new Error("Conflicting locked artifact integrity");
    known.set(key, entry.integrity);
  }
  for (const [path, entry] of Object.entries(next.packages)) {
    if (!entry.resolved || entry.link) continue;
    const expected = known.get(`${entry.resolved}\0${entry.version}`);
    if (expected && entry.integrity && entry.integrity !== expected) {
      throw new Error(`Registry artifact integrity changed without a new identity: ${path}`);
    }
    if (!entry.integrity && expected) entry.integrity = expected;
    if (!entry.integrity) throw new Error(`Missing reviewed artifact integrity: ${path}`);
  }
  return next;
}
