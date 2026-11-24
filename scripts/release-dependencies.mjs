import { readManifest, workspaces } from "./workspaces.mjs";
import { satisfiesWorkspaceDependency } from "./workspace-ranges.mjs";

export function* workspaceDependencies(manifest, byName) {
  for (const [name, range] of Object.entries({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
    if (byName.has(name)) yield [name, range];
    else if (name.startsWith("@oai404iao/")) throw new Error(`Unknown internal release dependency: ${manifest.name} -> ${name}`);
  }
}

export function assertReleaseDependencies(
  selected,
  entries = workspaces,
  manifestFor = entry => readManifest(entry.directory),
) {
  const byName = new Map(entries.map(entry => [entry.name, entry]));
  const selectedNames = new Set(selected.map(entry => entry.name));
  const checked = new Set();
  function visit(entry, path) {
    if (!entry || !byName.has(entry.name)) throw new Error("Unknown workspace in release batch");
    if (path.includes(entry.name)) throw new Error(`Workspace dependency cycle: ${[...path, entry.name].join(" -> ")}`);
    if (checked.has(entry.name)) return;
    const manifest = manifestFor(entry);
    for (const [name, version] of workspaceDependencies(manifest, byName)) {
      const dependency = byName.get(name);
      const chain = [...path, entry.name, name].join(" -> ");
      const depManifest = manifestFor(dependency);
      if (dependency.releaseStatus === "blocked" || depManifest.private === true) {
        throw new Error(`Release blocked by unpublished workspace dependency: ${chain}`);
      }
      if (!selectedNames.has(name)) {
        throw new Error(`Workspace dependency is outside this artifact batch: ${chain}`);
      }
      if (!satisfiesWorkspaceDependency(depManifest.version, version)) {
        throw new Error(`Workspace dependency ${chain}: ${depManifest.version} does not satisfy ${version}`);
      }
      visit(dependency, [...path, entry.name]);
    }
    checked.add(entry.name);
  }
  for (const entry of selected) visit(entry, []);
}

/** Stable dependency-first order; recovery candidates participate in the same DAG. */
export function orderReleaseWorkspaces(selected, manifestFor = entry => readManifest(entry.directory)) {
  const byName = new Map(selected.map(entry => [entry.name, entry]));
  if (byName.size !== selected.length) throw new Error("Duplicate workspace in release batch");
  const visiting = new Set();
  const done = new Set();
  const result = [];
  function visit(entry) {
    if (visiting.has(entry.name)) throw new Error(`Workspace dependency cycle at ${entry.name}`);
    if (done.has(entry.name)) return;
    visiting.add(entry.name);
    const manifest = manifestFor(entry);
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }).sort()) {
      if (byName.has(name)) visit(byName.get(name));
    }
    visiting.delete(entry.name);
    done.add(entry.name);
    result.push(entry);
  }
  for (const entry of [...selected].sort((a, b) => a.name.localeCompare(b.name))) visit(entry);
  return result;
}
