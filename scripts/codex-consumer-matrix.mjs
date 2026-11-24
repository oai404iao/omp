import semver from "semver";
import { isWorkspaceRange, satisfiesWorkspaceDependency } from "./workspace-ranges.mjs";

// Never override a registry dependency with a checkout outside its declared range.
export function sourceConsumerSelection(requested, manifests, lock) {
  const included = new Set();
  const resolutions = [];
  function visit(name) {
    if (included.has(name)) return;
    included.add(name);
    const manifest = manifests.get(name);
    for (const field of ["dependencies", "optionalDependencies"]) {
      for (const [dep, spec] of Object.entries(manifest[field] ?? {})) {
        if (!manifests.has(dep)) continue;
        if (typeof spec !== "string" || (!isWorkspaceRange(spec) && semver.valid(spec) !== spec)) {
          throw new Error(`Unsupported source dependency: ${name} -> ${dep}@${spec}`);
        }
        const version = manifests.get(dep).version;
        if (satisfiesWorkspaceDependency(version, spec)) visit(dep);
        else {
          const ref = lock.importers[`pi-extensions/${name.split("/").at(-1)}`]?.[field]?.[dep];
          if (ref?.specifier !== spec || !satisfiesWorkspaceDependency(ref.version?.split("(")[0], spec)) {
            throw new Error(`No compatible locked registry dependency for ${name} -> ${dep}@${spec} (checkout ${version})`);
          }
          resolutions.push({ owner: name, dependency: dep, version: ref.version.split("(")[0], range: spec, sourceVersion: version });
        }
      }
    }
  }
  requested.forEach(visit);
  return { included, resolutions };
}

export function incompatibleRuntimeLines(versions) {
  const unique = [...new Set(versions)];
  return unique.length > 1 && (unique.some(v => semver.prerelease(v)) || new Set(unique.map(v => semver.major(v))).size !== 1);
}

// Keep the exhaustive consumer contract as the default. Smoke only reduces
// selection: packing, isolated installation and each loader probe stay intact.
export function codexConsumerMatrix(mode = "full") {
  if (mode !== "full" && mode !== "smoke") {
    throw new Error(`Unknown OMP_CODEX_CONSUMER_MODE: ${mode}; expected full or smoke`);
  }
  const consumers = [
    ["runtime", ["pi-codex-runtime"], [], false],
    ["core", ["pi-codex-core"], [], true],
    ["tools", ["pi-codex-tools"], ["apply_patch", "web_search", "image_generation"], false],
    ["core-tools", ["pi-codex-core", "pi-codex-tools"], ["apply_patch", "web_search", "image_generation"], true],
    ["web", ["pi-codex-web-search"], ["web_search"], false],
    ["image", ["pi-codex-imagegen"], ["image_generation"], false],
    ["core-web", ["pi-codex-core", "pi-codex-web-search"], ["web_search"], true],
    ["core-image", ["pi-codex-core", "pi-codex-imagegen"], ["image_generation"], true],
    ["web-image", ["pi-codex-web-search", "pi-codex-imagegen"], ["web_search", "image_generation"], false],
    ["all", ["pi-codex-core", "pi-codex-tools", "pi-codex-web-search", "pi-codex-imagegen"], ["apply_patch", "web_search", "image_generation"], true],
    ["bundle", ["pi-codex-minimal-tools"], ["apply_patch", "web_search", "image_generation"], true],
    ["duplicate", ["pi-codex-minimal-tools", "pi-codex-core", "pi-codex-web-search", "pi-codex-imagegen"], ["apply_patch", "web_search", "image_generation"], true],
    ["subagent", ["pi-subagent"], [], false],
    ["subagent-no-optional", ["pi-subagent"], [], false],
  ];
  return {
    mode,
    consumers: mode === "full" ? consumers : consumers.filter(([label]) =>
      ["runtime", "core", "tools", "web", "image", "bundle", "subagent", "subagent-no-optional"].includes(label)),
    reverseOrders: mode === "full",
    capabilityMasks: mode === "full" ? [0, 1, 2, 3, 4, 5, 6] : [],
    separateRuntimeCopies: mode === "full",
  };
}
