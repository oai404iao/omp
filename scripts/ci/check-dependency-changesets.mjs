import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readChangesets } from "@changesets/read";
import { parseChangesetFile } from "@changesets/parse";
import semver from "semver";
import { readManifest, root, workspaces } from "../workspaces.mjs";

function declarations(manifest, names) {
  return ["dependencies", "optionalDependencies"].map(field => Object.fromEntries(
    Object.entries(manifest[field] ?? {}).filter(([name]) => names.has(name)),
  ));
}

export function requireDependencyChangeset(before, after, workspaceNames, releases, consumed = []) {
  if (isDeepStrictEqual(declarations(before, workspaceNames), declarations(after, workspaceNames))) return;
  if (before.version === after.version && releases.has(after.name)) return;
  const bump = ["major", "minor", "patch"].find(type => consumed.some(r => r.name === after.name && r.type === type));
  if (bump && semver.gt(after.version, before.version) && (semver.prerelease(before.version) ||
    semver.prerelease(after.version) || semver.inc(before.version, bump) === after.version)) return;
  throw new Error(`${after.name}: changing a workspace dependency declaration requires a changeset for this consumer`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [base] = process.argv.slice(2);
  if (!/^[a-f0-9]{40}$/.test(base)) throw new Error("Expected the pull request base commit SHA");
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  const manifests = new Set(git("diff", "--no-renames", "--diff-filter=M", "--name-only", "-z", base, "HEAD", "--", "pi-extensions/*/package.json").split("\0"));
  const changed = workspaces.filter(({ directory }) => manifests.has(`${directory}/package.json`));
  if (changed.length) {
    const names = new Set(workspaces.map(e => e.name));
    const releases = new Set((await readChangesets(root)).filter(c => !c.id.startsWith("pre/"))
      .flatMap(c => c.releases.filter(r => r.type !== "none").map(r => r.name)));
    const removed = git("diff", "--no-renames", "--diff-filter=D", "--name-only", "-z", base, "HEAD", "--", ".changeset").split("\0")
      .filter(p => /^\.changeset\/(?:pre\/)?[^/.][^/]*\.md$/.test(p) && !/\/(?:README|AGENTS|CLAUDE|GEMINI)\.md$/i.test(p));
    const consumed = removed.flatMap(path => parseChangesetFile(git("show", `${base}:${path}`)).releases);
    for (const { directory } of changed) {
      requireDependencyChangeset(JSON.parse(git("show", `${base}:${directory}/package.json`)), readManifest(directory), names, releases, consumed);
    }
  }
}
