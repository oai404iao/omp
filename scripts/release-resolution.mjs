import semver from "semver";
import { assertReleaseDependencies, orderReleaseWorkspaces, workspaceDependencies } from "./release-dependencies.mjs";
import { lookupPublishedVersion, lookupPublishedVersions, tagFor } from "./release-utils.mjs";
import { verifyDependencySource } from "./targeted-release.mjs";
import { isWorkspaceRange, satisfiesWorkspaceDependency } from "./workspace-ranges.mjs";
import { readManifest, workspaces } from "./workspaces.mjs";

export function publishedWorkspace(entry, version, commit, { lookup = lookupPublishedVersion, check = verifyDependencySource } = {}) {
  const { name, directory } = entry;
  if (entry.releaseStatus !== "publishable" || !version || semver.valid(version) !== version) throw new Error(`Invalid registry workspace: ${name}@${version}`);
  const tag = tagFor(name, version);
  const metadata = lookup(name, version);
  if (!metadata.exists) throw new Error(`Release dependency must already be published: ${tag}`);
  const prerelease = !!semver.prerelease(version);
  const candidate = { name, version, directory, tag, mode: "verify", integrity: metadata.integrity,
    sourceCommit: metadata.gitHead, distTag: prerelease ? "next" : "latest", prerelease };
  return { candidate, manifest: check(candidate, metadata, commit) };
}

// Resolve once, before packing. Only the selected roots may use checkout artifacts.
// A shared workspace must have one concrete version that fits *all* incoming edges:
// a global file override during the installation test would otherwise hide conflicts.
export function resolveReleaseWorkspaces(targets, commit, { entries = workspaces, checkout = e => readManifest(e.directory),
  versions = lookupPublishedVersions, lookup = lookupPublishedVersion, check = verifyDependencySource, available = new Map() } = {}) {
  const byName = new Map(entries.map(entry => [entry.name, entry]));
  const history = new Map(), immutable = new Map();
  function workspace(name) {
    const entry = byName.get(name);
    if (entry?.releaseStatus !== "publishable") throw new Error(`Unapproved release target or dependency: ${name}`);
    const manifest = checkout(entry);
    if (manifest.private || manifest.name !== name) throw new Error(`Invalid release workspace identity: ${name}`);
    return manifest;
  }
  function matchingVersions(name, ranges) {
    const exact = ranges.find(range => !isWorkspaceRange(range));
    if (!exact && !history.has(name)) history.set(name, versions(name));
    const matches = (exact ? [exact] : history.get(name)).filter(version => semver.valid(version) === version
      && ranges.every(range => satisfiesWorkspaceDependency(version, range))).sort(semver.rcompare);
    return [...matches.filter(v => !semver.prerelease(v)), ...matches.filter(v => semver.prerelease(v))];
  }
  const roots = new Map(targets.map(name => [name, { manifest: workspace(name) }]));
  let states = 0, conflict;
  function solve(chosen) {
    if (++states > 512) throw new Error("Release compatibility resolution exceeded 512 combinations");
    const requirements = new Map();
    for (const { manifest } of chosen.values()) {
      for (const [name, range] of workspaceDependencies(manifest, byName)) {
        if (!range || !isWorkspaceRange(range) && semver.valid(range) !== range) throw new Error(`Invalid historical workspace dependency ${name}: ${range}`);
        if (!requirements.has(name)) requirements.set(name, []);
        requirements.get(name).push(range);
      }
    }
    for (const [name, ranges] of requirements) {
      const selected = chosen.get(name);
      if (selected && !ranges.every(range => satisfiesWorkspaceDependency(selected.manifest.version, range))) {
        conflict = `${name} satisfies ${ranges.join(", ")} with ${selected.manifest.version} selected`;
        return;
      }
    }
    const name = [...requirements.keys()].sort().find(name => !chosen.has(name));
    if (!name) return chosen;
    workspace(name);
    const ranges = requirements.get(name);
    conflict = `${name} satisfies ${ranges.join(", ")}`;
    // Alternate consumer installations can reuse other already verified batch artifacts.
    // Ordinary preparation has no additional local candidates beyond its explicit roots.
    const offered = available.get(name);
    if (offered && ranges.every(range => satisfiesWorkspaceDependency(offered.manifest.version, range))) {
      const result = solve(new Map(chosen).set(name, offered));
      if (result) return result;
    }
    for (const version of matchingVersions(name, ranges)) {
      if (version === offered?.manifest.version) continue;
      const key = tagFor(name, version);
      // Only a SemVer conflict may try another version. Registry, integrity,
      // identity and source failures propagate; they are never a downgrade signal.
      if (!immutable.has(key)) immutable.set(key, publishedWorkspace(byName.get(name), version, commit, { lookup, check }));
      const result = solve(new Map(chosen).set(name, immutable.get(key)));
      if (result) return result;
    }
  }
  const selection = solve(roots);
  if (!selection) throw new Error(`No published combination: no ${conflict}`);
  const selected = [...selection.keys()].map(name => byName.get(name));
  const manifestFor = entry => selection.get(entry.name)?.manifest;
  assertReleaseDependencies(selected, entries, manifestFor);
  return orderReleaseWorkspaces(selected, manifestFor).map(entry => ({ entry, ...selection.get(entry.name) }));
}
