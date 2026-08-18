import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { registry, root } from "./workspaces.mjs";

export const npm = process.platform === "win32" ? "npm.cmd" : "npm";

export function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

export function currentCommit() {
  return git(["rev-parse", "HEAD"]);
}

export function tagFor(name, version) {
  return `${name}@${version}`;
}

export function lookupPublishedVersion(name, version) {
  const result = spawnSync(
    npm,
    ["view", `${name}@${version}`, "version", "gitHead", "--json", "--registry", registry],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, npm_config_loglevel: "error" },
    },
  );

  if (result.status !== 0) {
    const output = `${result.stdout}\n${result.stderr}`;
    if (/\bE404\b|404 Not Found/i.test(output)) return { exists: false };
    throw new Error(`npm view failed for ${name}@${version}: ${output.trim()}`);
  }

  const value = JSON.parse(result.stdout);
  const publishedVersion = typeof value === "string" ? value : value?.version;
  const gitHead = typeof value === "object" && value ? value.gitHead : undefined;
  if (publishedVersion !== version) {
    throw new Error(`npm returned version ${String(publishedVersion)} for ${name}@${version}`);
  }
  return {
    exists: true,
    version: publishedVersion,
    gitHead: typeof gitHead === "string" ? gitHead : undefined,
  };
}

export function lookupDistTags(name) {
  const result = spawnSync(
    npm,
    ["view", name, "dist-tags", "--json", "--registry", registry],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, npm_config_loglevel: "error" },
    },
  );
  if (result.status !== 0) {
    throw new Error(`npm dist-tag lookup failed for ${name}: ${(result.stderr || result.stdout).trim()}`);
  }
  const value = JSON.parse(result.stdout);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`npm returned malformed dist-tags for ${name}`);
  }
  return value;
}

export function existingTagCommit(tag) {
  const result = spawnSync("git", ["rev-list", "-n", "1", tag], {
    cwd: root,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

export function sha512(path) {
  return `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}`;
}

export function releaseNotes(directory, name, version, commit) {
  const changelogPath = resolve(root, directory, "CHANGELOG.md");
  if (!existsSync(changelogPath)) return `${name} ${version}\n\nSource commit: \`${commit}\``;

  const lines = readFileSync(changelogPath, "utf8").split(/\r?\n/);
  const heading = new RegExp(`^##\\s+${version.replaceAll(".", "\\.")}(?:\\s|$)`);
  const start = lines.findIndex((line) => heading.test(line.trim()));
  if (start < 0) return `${name} ${version}\n\nSource commit: \`${commit}\``;

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}
