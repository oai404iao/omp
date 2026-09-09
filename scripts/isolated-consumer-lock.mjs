/**
 * Project a production dependency closure from the reviewed root lock, retaining
 * exact registry URLs/integrities. No package is linked to workspace node_modules.
 */
export function isolatedConsumerLock(name, included, manifests, artifacts, sourceLock) {
  const source = sourceLock.packages;
  const packages = {};
  const dependencies = {};
  const visited = new Set();
  const workspaceLocations = new Map([...manifests.keys()].map(pkg => [
    `pi-extensions/${pkg.split("/")[1]}`, `node_modules/${pkg}`,
  ]));
  const relocated = path => {
    for (const [from, to] of workspaceLocations) {
      if (path.startsWith(`${from}/node_modules/`)) return to + path.slice(from.length);
    }
    return path;
  };
  function locate(from, dependency) {
    let parent = from;
    while (true) {
      const candidate = `${parent ? `${parent}/` : ""}node_modules/${dependency}`;
      if (source[candidate]) return candidate;
      if (!parent) return undefined;
      const index = parent.lastIndexOf("/node_modules/");
      parent = index < 0 ? "" : parent.slice(0, index);
    }
  }
  function visit(path) {
    if (visited.has(path)) return;
    visited.add(path);
    const entry = structuredClone(source[path]);
    if (entry.link || !entry.resolved || !entry.integrity) {
      throw new Error(`Unpinned or linked external dependency: ${path}`);
    }
    if (!entry.resolved.startsWith("https://registry.npmjs.org/")) {
      throw new Error(`External dependency is not a locked registry artifact: ${path}`);
    }
    delete entry.dev;
    delete entry.devOptional;
    packages[relocated(path)] = entry;
    for (const dependency of Object.keys({ ...entry.dependencies, ...entry.optionalDependencies, ...entry.peerDependencies })) {
      const target = locate(path, dependency);
      if (target) visit(target);
      else if (!(dependency in (entry.optionalDependencies ?? {})) && !entry.peerDependenciesMeta?.[dependency]?.optional) {
        throw new Error(`Missing locked dependency: ${path} -> ${dependency}`);
      }
    }
  }
  for (const pkg of included) {
    const manifest = manifests.get(pkg);
    const artifact = artifacts.get(pkg);
    dependencies[pkg] = `file:${artifact.path}`;
    packages[`node_modules/${pkg}`] = {
      name: pkg, version: manifest.version, resolved: `file:${artifact.path}`, integrity: artifact.integrity,
      dependencies: manifest.dependencies, optionalDependencies: manifest.optionalDependencies,
      peerDependencies: manifest.peerDependencies, peerDependenciesMeta: manifest.peerDependenciesMeta,
      engines: manifest.engines,
    };
    const location = `pi-extensions/${pkg.split("/")[1]}`;
    for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
      if (manifests.has(dependency)) continue;
      const path = locate(location, dependency);
      if (!path) throw new Error(`Missing locked dependency: ${pkg} -> ${dependency}`);
      visit(path);
    }
    for (const dependency of Object.keys(manifest.peerDependencies ?? {})) {
      const path = locate("", dependency);
      if (!path) throw new Error(`Missing locked Pi host peer: ${dependency}`);
      visit(path);
      const entry = source[path];
      dependencies[dependency] = entry.name && entry.name !== dependency
        ? `npm:${entry.name}@${entry.version}` : entry.version;
    }
  }
  const manifest = { name, version: "1.0.0", private: true, type: "module", dependencies };
  packages[""] = { name, version: manifest.version, dependencies };
  return { manifest, lock: { name, version: manifest.version, lockfileVersion: 3, requires: true, packages } };
}
