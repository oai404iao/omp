import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { releaseFinalizationIssues } from "./release-result.mjs";
import { root } from "./workspaces.mjs";

const [resultArgument] = process.argv.slice(2);
if (!resultArgument) throw new Error("usage: finalize-github-releases.mjs <result.json>");

const result = JSON.parse(readFileSync(resolve(root, resultArgument), "utf8"));
const finalizationIssues = releaseFinalizationIssues(result);
if (finalizationIssues.length > 0) {
  for (const issue of finalizationIssues) console.error(`- ${issue}`);
  throw new Error("npm publication was incomplete; tags and GitHub Releases were not finalized");
}

const tags = result.releases.map((release) => release.tag);
execFileSync("git", ["push", "--atomic", "origin", ...tags], {
  cwd: root,
  stdio: "inherit",
});

const notesDirectory = mkdtempSync(resolve(tmpdir(), "omp-release-notes-"));
for (const release of result.releases) {
  const existing = spawnSync("gh", ["release", "view", release.tag], {
    cwd: root,
    encoding: "utf8",
  });
  if (existing.status === 0) {
    console.log(`✓ GitHub Release ${release.tag} already exists`);
    continue;
  }

  const notesPath = resolve(notesDirectory, `${release.name.replaceAll("/", "-")}-${release.version}.md`);
  writeFileSync(notesPath, `${release.notes.trim()}\n`);
  const releaseArguments = [
    "release",
    "create",
    release.tag,
    "--verify-tag",
    "--title",
    release.tag,
    "--notes-file",
    notesPath,
  ];
  if (release.prerelease) releaseArguments.push("--prerelease");
  execFileSync(
    "gh",
    releaseArguments,
    { cwd: root, stdio: "inherit" },
  );
}

console.log(`Finalized ${result.releases.length} GitHub release(s) for ${result.commit}.`);
