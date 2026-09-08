import { readManifest, workspaces } from "./workspaces.mjs";

export function assertReleaseDependencies(
  selected,
  entries = workspaces,
  manifestFor = entry => readManifest(entry.directory),
) {
  const byName = new Map(entries.map(entry => [entry.name, entry]));
  const selectedNames = new Set(selected.map(entry => entry.name));
  const checked = new Set();
  function visit(entry, path) {
    if (path.includes(entry.name)) throw new Error(`Workspace dependency cycle: ${[...path, entry.name].join(" -> ")}`);
    if (checked.has(entry.name)) return;
    const manifest = manifestFor(entry);
    for (const [name, version] of Object.entries({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
      const dependency = byName.get(name);
      if (!dependency) continue;
      const chain = [...path, entry.name, name].join(" -> ");
      const depManifest = manifestFor(dependency);
      if (dependency.releaseStatus === "blocked" || depManifest.private === true) {
        throw new Error(`Release blocked by unpublished workspace dependency: ${chain}`);
      }
      if (version !== depManifest.version) throw new Error(`Workspace dependency must be exactly pinned: ${chain}`);
      if (dependency.releaseStatus === "bootstrap" && !selectedNames.has(name)) {
        throw new Error(`Bootstrap dependency is outside this artifact batch: ${chain}`);
      }
      visit(dependency, [...path, entry.name]);
    }
    checked.add(entry.name);
  }
  for (const entry of selected) visit(entry, []);
}
