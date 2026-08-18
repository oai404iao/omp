import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readManifest, root, workspaces } from "./workspaces.mjs";

const repository = process.env.GITHUB_REPOSITORY;
const expectedRepositoryUrl = repository
  ? `git+https://github.com/${repository}.git`
  : undefined;

function fail(message) {
  console.error(`release preflight: ${message}`);
  process.exit(1);
}

if (process.env.RELEASE_INFRASTRUCTURE_ENABLED !== "true") {
  fail("publishing is hard-disabled in .github/workflows/publish.yml");
}
if (process.env.NPM_PUBLISH_ENABLED !== "true") {
  fail("the npm-publish environment variable NPM_PUBLISH_ENABLED is not true");
}
if (process.env.PUBLISH_CONFIRMATION !== "publish") {
  fail('workflow confirmation must be exactly "publish"');
}
if (repository !== "oai404iao/omp") {
  fail(`expected the GitHub repository oai404iao/omp, found ${repository ?? "(missing)"}`);
}
if (process.env.GITHUB_REF !== "refs/heads/main") {
  fail(`publishing is allowed only from refs/heads/main, found ${process.env.GITHUB_REF ?? "(missing)"}`);
}

const status = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
if (status.trim().length > 0) fail("the release checkout is dirty");

const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
if (process.env.GITHUB_SHA && head !== process.env.GITHUB_SHA) {
  fail(`checkout HEAD ${head} does not match GITHUB_SHA ${process.env.GITHUB_SHA}`);
}

for (const { name, directory } of workspaces) {
  const packageRoot = resolve(root, directory);
  const manifest = readManifest(directory);
  const repositoryField = manifest.repository;

  if (
    repositoryField?.type !== "git"
    || repositoryField?.url !== expectedRepositoryUrl
    || repositoryField?.directory !== directory
  ) {
    fail(`${name} repository metadata must exactly target ${expectedRepositoryUrl} with directory ${directory}`);
  }
  if (manifest.homepage !== `https://github.com/${repository}/tree/main/${directory}#readme`) {
    fail(`${name} homepage metadata is missing or does not target the public repository`);
  }
  if (manifest.bugs?.url !== `https://github.com/${repository}/issues`) {
    fail(`${name} bugs metadata is missing or does not target the public repository`);
  }
  if (!existsSync(resolve(packageRoot, "LICENSE"))) {
    fail(`${name} has no package-level LICENSE file; complete the rights audit before publishing`);
  }
}

const codexNotice = resolve(root, "pi-extensions/pi-codex-minimal-tools/THIRD_PARTY_NOTICES.md");
if (!existsSync(codexNotice)) {
  fail("pi-codex-minimal-tools has no THIRD_PARTY_NOTICES.md; complete its source audit before publishing");
}
const codexManifest = readManifest("pi-extensions/pi-codex-minimal-tools");
if (!codexManifest.files?.includes("THIRD_PARTY_NOTICES.md")) {
  fail("pi-codex-minimal-tools must include THIRD_PARTY_NOTICES.md in its npm files allowlist");
}

console.log(`release preflight passed for ${repository} at ${head}`);
