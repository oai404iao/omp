import { execFileSync } from "node:child_process";
import { root } from "./workspaces.mjs";

/** Only a registered package that declared the dependency at a reachable source can be its published consumer. */
export function latestConsumerEntries(candidates, entries, commit, cwd = root) {
  const published = candidates.filter(c => c.mode === "publish").map(c => c.name);
  const possible = entries.filter(e => e.releaseStatus === "publishable" && published.some(name => name !== e.name));
  if (!possible.length) return [];
  const git = (args, input) => execFileSync("git", args, { cwd, input, maxBuffer: 32 * 1024 * 1024 });
  if (git(["rev-parse", "--is-shallow-repository"]).toString().trim() !== "false") throw new Error("Compatibility inventory requires full Git history");
  if (!/^[a-f0-9]{40,64}$/i.test(commit)) throw new Error("Compatibility inventory requires an exact release commit");
  return possible.filter(entry => {
    const path = `${entry.directory}/package.json`;
    // --full-history keeps both sides of merges, including a removed optional edge on an ancestor.
    const revisions = git(["log", "--full-history", "--format=%H", commit, "--", path]).toString().trim().split(/\s+/).filter(Boolean);
    const objects = [...new Set([commit, ...revisions])].map(rev => `${rev}:${path}`);
    const bytes = git(["cat-file", "--batch"], `${objects.join("\n")}\n`);
    for (let offset = 0; offset < bytes.length;) {
      const end = bytes.indexOf(10, offset), header = bytes.toString("utf8", offset, end);
      if (end < 0) throw new Error("Truncated git cat-file inventory");
      offset = end + 1;
      if (header.endsWith(" missing")) continue; // The file was deleted at this revision.
      const size = /^[a-f0-9]+ blob (\d+)$/.exec(header)?.[1];
      if (!size || bytes[offset + Number(size)] !== 10) throw new Error(`Invalid manifest blob in ${path} history`);
      let manifest;
      try { manifest = JSON.parse(bytes.toString("utf8", offset, offset + Number(size))); } catch { return true; } // Inconclusive: verify registry source.
      offset += Number(size) + 1;
      const deps = { ...manifest?.dependencies, ...manifest?.optionalDependencies };
      if (manifest?.name === entry.name && published.some(name => name !== entry.name && Object.hasOwn(deps, name))) return true;
    }
    return false;
  });
}
