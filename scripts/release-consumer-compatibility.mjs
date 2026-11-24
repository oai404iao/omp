import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { acquireArtifacts, recheckArtifacts } from "./release-consumer-artifacts.mjs";
import { latestConsumerEntries } from "./release-consumer-compatibility-history.mjs";
import { installConsumers } from "./release-consumer-install.mjs";
import { candidateClosure } from "./release-consumer-lock.mjs";
import { publishedWorkspace, resolveReleaseWorkspaces } from "./release-resolution.mjs";
import { lookupDistTags } from "./release-utils.mjs";
import { readManifest, workspaces } from "./workspaces.mjs";
import { isWorkspaceRange, satisfiesWorkspaceDependency } from "./workspace-ranges.mjs";

const edges = manifest => ({ ...manifest.dependencies, ...manifest.optionalDependencies });
const short = name => name.split("/").at(-1);
export const artifactIdentity = ({ name, version, sourceCommit, integrity }) => ({ name, version, sourceCommit, integrity });

export function compatibilityCases(candidates, manifests, latest, entries) {
  const cases = [];
  for (const candidate of candidates.filter(c => c.mode === "publish")) {
    const { name, version } = candidate;
    const floors = Object.fromEntries(Object.entries(edges(manifests.get(name)))
      .filter(([dep, range]) => entries.some(e => e.name === dep) && isWorkspaceRange(range))
      .map(([dep, range]) => [dep, range.slice(1)]));
    if (Object.keys(floors).length) cases.push({ label: `floor-${short(name)}`, subject: name, requested: name, floors });
    for (const [consumer, { manifest }] of latest) {
      const range = edges(manifest)[name];
      if (consumer === name || range === undefined) continue;
      if (!isWorkspaceRange(range) && !satisfiesWorkspaceDependency(range, range)) throw new Error(`Unsupported historical declaration: ${consumer} -> ${name}@${range}`);
      cases.push({ label: `published-${short(consumer)}-with-${short(name)}`, subject: name, requested: consumer,
        range, excluded: !satisfiesWorkspaceDependency(version, range) });
    }
  }
  return cases;
}

export async function verifyCompatibility({ candidates, manifests, artifacts, lock, directory, commit, runner, acquisition,
  entries = workspaces, checkout = e => readManifest(e.directory), latestTag = name => lookupDistTags(name).latest,
  resolution = {}, inventory = latestConsumerEntries }) {
  const entry = name => entries.find(e => e.name === name);
  const base = new Map(candidates.map(candidate => [candidate.name, { candidate, manifest: manifests.get(candidate.name) }]));
  const immutable = new Map();
  function published(name, version) {
    const key = `${name}@${version}`;
    if (!immutable.has(key)) immutable.set(key, publishedWorkspace(entry(name), version, commit, resolution));
    return immutable.get(key);
  }
  const latest = new Map(inventory(candidates, entries, commit).map(({ name }) => [name, published(name, latestTag(name))]));
  const checks = [];
  for (const plan of compatibilityCases(candidates, manifests, latest, entries)) {
    const { label, subject, requested, floors } = plan;
    if (plan.excluded) {
      checks.push({ ...plan, status: "outside-declared-range" });
      continue;
    }
    let group;
    const roots = new Map();
    if (floors && Object.entries(floors).every(([dep, floor]) => base.get(dep).candidate.version === floor)) {
      // These exact bytes already passed the standalone isolated install and loader.
      group = [...candidateClosure([subject], manifests)].map(name => base.get(name));
    } else {
      roots.set(subject, base.get(subject));
      if (floors) {
        for (const [dep, floor] of Object.entries(floors)) {
          roots.set(dep, base.get(dep).candidate.version === floor ? base.get(dep) : published(dep, floor));
        }
      } else {
        roots.set(requested, latest.get(requested));
      }
      group = resolveReleaseWorkspaces([...roots.keys()], commit, { ...resolution, entries,
        available: new Map([...base].filter(([, x]) => x.candidate.mode === "publish")),
        checkout: e => roots.get(e.name)?.manifest ?? checkout(e) }).map(({ entry, candidate, manifest }) => {
        const selected = roots.get(entry.name) ?? { candidate, manifest }, original = base.get(entry.name);
        if (original?.candidate.version !== selected.candidate.version) return selected;
        assert.deepEqual(artifactIdentity(original.candidate), artifactIdentity(selected.candidate));
        return original;
      });
      const selected = group.map(x => x.candidate), sources = new Map(group.map(x => [x.manifest.name, x.manifest]));
      const included = candidateClosure([requested], sources);
      assert.equal(included.size, group.length, `Unexpected artifacts in ${label}`);
      const dir = join(directory, label); mkdirSync(dir);
      const missing = selected.filter(c => c !== base.get(c.name)?.candidate);
      const files = new Map([...artifacts, ...await acquireArtifacts(missing, sources, dir, dir, { commit, ...acquisition })]);
      installConsumers(selected, sources, files, lock, dir, runner, [{ label: "consumer", requested: [requested], included }]);
      recheckArtifacts(selected, sources, files);
    }
    checks.push({ ...plan, status: "installed", artifacts: group.map(x => artifactIdentity(x.candidate)) });
  }
  return { latest: [...latest.values()].map(x => artifactIdentity(x.candidate)), checks };
}
