import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  currentCommit,
  existingTagCommit,
  lookupPublishedVersion,
  npm,
  releaseNotes,
  sha512,
  tagFor,
} from "./release-utils.mjs";
import { publishableWorkspaces, readManifest, registry, root } from "./workspaces.mjs";

const outputDirectory = resolve(root, "release-artifacts");
const stagingDirectory = resolve(outputDirectory, ".staging");
const commit = currentCommit();
const candidates = [];

rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(outputDirectory, { recursive: true });

function verifyPublishedSource(name, version, directory, sourceCommit, tag) {
  if (!/^[0-9a-f]{40,64}$/i.test(sourceCommit)) {
    throw new Error(`${name}@${version} has invalid npm gitHead ${sourceCommit}`);
  }

  const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", sourceCommit, commit], {
    cwd: root,
    encoding: "utf8",
  });
  if (ancestry.status !== 0) {
    throw new Error(`${name}@${version} npm gitHead ${sourceCommit} is not an ancestor of ${commit}`);
  }

  const historicalManifest = spawnSync(
    "git",
    ["show", `${sourceCommit}:${directory}/package.json`],
    { cwd: root, encoding: "utf8" },
  );
  if (historicalManifest.status !== 0) {
    throw new Error(`${name}@${version} package.json is unavailable at npm gitHead ${sourceCommit}`);
  }
  const historical = JSON.parse(historicalManifest.stdout);
  if (historical.name !== name || historical.version !== version) {
    throw new Error(
      `${name}@${version} does not match package identity at npm gitHead ${sourceCommit}`,
    );
  }

  const tagCommit = existingTagCommit(tag);
  if (tagCommit && tagCommit !== sourceCommit) {
    throw new Error(`tag ${tag} points to ${tagCommit}, but npm gitHead is ${sourceCommit}`);
  }
}

for (const { name, directory } of publishableWorkspaces) {
  const manifest = readManifest(directory);
  if (manifest.private === true) {
    throw new Error(`${name} is approved in workspaces.mjs but remains private in package.json`);
  }
  const published = lookupPublishedVersion(name, manifest.version);
  const tag = tagFor(name, manifest.version);
  const localTagCommit = existingTagCommit(tag);

  if (published.exists) {
    if (!published.gitHead) {
      throw new Error(
        `${name}@${manifest.version} exists on npm without gitHead; release identity is ambiguous`,
      );
    }
    verifyPublishedSource(name, manifest.version, directory, published.gitHead, tag);
    candidates.push({
      name,
      version: manifest.version,
      directory,
      tag,
      mode: "recover",
      sourceCommit: published.gitHead,
      distTag: manifest.version.includes("-") ? "next" : "latest",
      prerelease: manifest.version.includes("-"),
      notes: releaseNotes(directory, name, manifest.version, published.gitHead),
    });
    console.log(`↻ ${name}@${manifest.version}: reconcile release from ${published.gitHead}`);
    continue;
  }
  if (localTagCommit && localTagCommit !== commit) {
    throw new Error(`unpublished version ${name}@${manifest.version} has a conflicting local tag at ${localTagCommit}`);
  }

  const stagedPackage = resolve(stagingDirectory, name);
  cpSync(resolve(root, directory), stagedPackage, {
    recursive: true,
    filter: (source) => !source.split(/[\\/]/).includes("node_modules"),
  });
  const stagedManifestPath = resolve(stagedPackage, "package.json");
  const stagedManifest = JSON.parse(readFileSync(stagedManifestPath, "utf8"));
  stagedManifest.gitHead = commit;
  writeFileSync(stagedManifestPath, `${JSON.stringify(stagedManifest, null, 2)}\n`);

  const packed = spawnSync(
    npm,
    [
      "pack",
      stagedPackage,
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      outputDirectory,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, npm_config_loglevel: "error" },
    },
  );
  if (packed.status !== 0) {
    throw new Error(`npm pack failed for ${name}: ${(packed.stderr || packed.stdout).trim()}`);
  }

  const output = JSON.parse(packed.stdout);
  if (!Array.isArray(output) || output.length !== 1) {
    throw new Error(`npm pack returned an unexpected result for ${name}`);
  }
  const item = output[0];
  if (item.name !== name || item.version !== manifest.version || typeof item.filename !== "string") {
    throw new Error(`npm pack identity mismatch for ${name}@${manifest.version}`);
  }

  const filename = item.filename;
  const tarballPath = resolve(outputDirectory, filename);
  rmSync(stagedPackage, { recursive: true, force: true });
  candidates.push({
    name,
    version: manifest.version,
    directory,
    tag,
    mode: "publish",
    sourceCommit: commit,
    distTag: manifest.version.includes("-") ? "next" : "latest",
    prerelease: manifest.version.includes("-"),
    filename,
    integrity: sha512(tarballPath),
    notes: releaseNotes(directory, name, manifest.version, commit),
  });
  console.log(`+ ${name}@${manifest.version}: packed ${filename}`);
}

rmSync(stagingDirectory, { recursive: true, force: true });

if (candidates.length === 0) {
  throw new Error("no unpublished package versions or recoverable releases were found");
}

const releaseManifest = {
  schemaVersion: 1,
  commit,
  registry,
  candidates,
};
writeFileSync(
  resolve(outputDirectory, "manifest.json"),
  `${JSON.stringify(releaseManifest, null, 2)}\n`,
);
console.log(`Prepared ${candidates.length} release candidate(s) for ${commit}.`);
