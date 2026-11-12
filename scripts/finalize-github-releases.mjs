import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
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
const plans = result.releases.map((release) => {
  assert.match(release.sourceCommit, /^[a-f0-9]{40}$/, "release source commit is required");
  const local = execFileSync("git", ["rev-parse", `${release.tag}^{}`], { cwd: root, encoding: "utf8" }).trim();
  assert.equal(local, release.sourceCommit, `local tag ${release.tag} points to another commit`);
  const remote = execFileSync("git", ["ls-remote", "--tags", "origin", `refs/tags/${release.tag}`, `refs/tags/${release.tag}^{}`], {
    cwd: root, encoding: "utf8",
  }).trim();
  if (remote) {
    const refs = new Map(remote.split("\n").map(line => line.split(/\s+/).reverse()));
    const commit = refs.get(`refs/tags/${release.tag}^{}`) ?? refs.get(`refs/tags/${release.tag}`);
    assert.equal(commit, release.sourceCommit, `remote tag ${release.tag} points to another commit`);
  }
  const existing = spawnSync("gh", ["release", "view", release.tag, "--json", "tagName,name,body,isPrerelease,isDraft"], {
    cwd: root, encoding: "utf8",
  });
  if (existing.status !== 0) {
    if (existing.error || !/release not found/i.test(existing.stderr ?? "")) {
      throw new Error(`Cannot verify GitHub Release ${release.tag}: ${existing.error?.message ?? existing.stderr}`);
    }
    return { release, action: "create" };
  }
  const current = JSON.parse(existing.stdout);
  assert.equal(current.tagName, release.tag, "GitHub Release tag differs");
  assert.equal(current.isDraft, false, "existing GitHub Release is a draft");
  assert.equal(typeof current.name, "string");
  assert.equal(typeof current.body, "string");
  assert.equal(typeof current.isPrerelease, "boolean");
  if (current.name.trim()) assert.equal(current.name, release.tag, "existing GitHub Release title conflicts");
  if (current.body.trim()) assert.equal(current.body.trim(), release.notes.trim(), "existing GitHub Release notes conflict");
  if (current.isPrerelease && !release.prerelease) throw new Error("existing GitHub Release prerelease conflicts");
  const title = !current.name.trim();
  const notes = !current.body.trim();
  const prerelease = current.isPrerelease !== release.prerelease;
  return { release, action: title || notes || prerelease ? "edit" : "skip", title, notes, prerelease };
});
execFileSync("git", ["push", "--atomic", "origin", ...tags], {
  cwd: root,
  stdio: "inherit",
});

const notesDirectory = mkdtempSync(resolve(tmpdir(), "omp-release-notes-"));
for (const { release, action, title, notes, prerelease } of plans) {
  if (action === "skip") {
    console.log(`✓ GitHub Release ${release.tag} already matches`);
    continue;
  }

  const notesPath = resolve(notesDirectory, `${release.name.replaceAll("/", "-")}-${release.version}.md`);
  writeFileSync(notesPath, `${release.notes.trim()}\n`);
  const releaseArguments = ["release", action, release.tag];
  if (action === "create" || title) releaseArguments.push("--title", release.tag);
  if (action === "create" || notes) releaseArguments.push("--notes-file", notesPath);
  if (action === "create") releaseArguments.push("--verify-tag");
  if (release.prerelease && (action === "create" || prerelease)) releaseArguments.push("--prerelease");
  execFileSync(
    "gh",
    releaseArguments,
    { cwd: root, stdio: "inherit" },
  );
}

console.log(`Finalized ${result.releases.length} GitHub release(s) for ${result.commit}.`);
