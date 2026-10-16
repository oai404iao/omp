import { spawnSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { root as repositoryRoot, workspaces } from "../workspaces.mjs";
import { targetedReleaseWorkspaces } from "../targeted-release.mjs";
import { buildGraph, integrationPackages, readPackage, reverseClosure, suites,
  taskCatalog, testPackages, validateRepositoryCatalog } from "./catalog.mjs";

class GitError extends Error {}
export function git(args, root = repositoryRoot) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new GitError(`git ${args[0]} failed`);
  return result.stdout;
}

export function parseDiff(output) {
  const tokens = output.split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  const paths = [];
  for (let i = 0; i < tokens.length;) {
    const status = tokens[i++];
    const count = /^[RC]\d+$/.test(status) ? 2 : /^[ACDMTUXB]$/.test(status) ? 1 : 0;
    if (!count || i + count > tokens.length) throw new GitError("Unrecognized git diff output");
    paths.push(...tokens.slice(i, i += count));
  }
  return [...new Set(paths)].sort();
}

const allPackages = testPackages.map(entry => entry.id);
function plan(mode, sourceSha, packages, selectedSuites, reasons, full = false) {
  return validatePlan({ schemaVersion: 1, mode, sourceSha, packages: [...packages].sort(),
    suites: suites.filter(id => selectedSuites.includes(id)), policy: true, reasons, full });
}
function fullPlan(mode, sourceSha, reason) {
  return plan(mode, sourceSha, allPackages, suites, [reason], true);
}

// Only explicitly non-runtime repository documentation is exempt from fallback.
function policyOnlyPath(path) {
  return /^(README|CONTRIBUTING|RELEASING|SECURITY|AGENTS)\.md$/.test(path) ||
    /^docs\/.*\.md$/.test(path) || /^\.changeset\/[^/]+\.md$/.test(path) ||
    path === ".github/pull_request_template.md";
}

export function affectedPlan(paths, graphs, sourceSha) {
  const owners = new Set();
  const selectedSuites = new Set();
  const reasons = [];
  for (const path of [...new Set(paths)].sort()) {
    const owner = testPackages.find(entry => path.startsWith(`${entry.directory}/`));
    if (owner) {
      owners.add(owner.id);
      reasons.push(`Package change: ${path}`);
    } else if (path.startsWith("tests/codex/")) {
      selectedSuites.add("composition");
      selectedSuites.add("consumers");
      reasons.push(`Shared Codex test change: ${path}`);
    } else if (policyOnlyPath(path)) {
      reasons.push(`Policy-only documentation: ${path}`);
    } else {
      return fullPlan("affected", sourceSha, `Full fallback: unclassified or shared path ${path}`);
    }
  }
  const packages = reverseClosure(owners, graphs);
  if (packages.some(id => integrationPackages.has(id))) {
    selectedSuites.add("composition");
    selectedSuites.add("consumers");
  }
  if (!reasons.length) reasons.push("No changed paths; policy checks still required");
  if (packages.length > owners.size) reasons.push("Included recursive reverse workspace dependencies from base and head");
  return plan("affected", sourceSha, packages, [...selectedSuites], reasons);
}

/** Affected plans describe immutable revisions, not unstaged/staged local changes. */
export function createPlan({ mode = "full", packageName, base, head = "HEAD",
  root = repositoryRoot, git: gitRunner = args => git(args, root) } = {}) {
  if (!["full", "affected", "release"].includes(mode)) throw new Error(`Invalid plan mode: ${mode}`);
  validateRepositoryCatalog(root);
  let sourceSha;
  try {
    sourceSha = gitRunner(["rev-parse", "--verify", "--end-of-options", `${head}^{commit}`]).trim();
    if (!/^[a-f\d]{40,64}$/i.test(sourceSha)) throw new GitError("Invalid head revision");
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    if (mode === "release") throw error;
    return fullPlan(mode, "unknown", `Full fallback: unavailable head revision ${head}`);
  }
  if (mode === "full") {
    buildGraph(testPackages, entry => readPackage(entry, root));
    return fullPlan(mode, sourceSha, "Explicit full verification");
  }
  if (mode === "release") {
    buildGraph(testPackages, entry => readPackage(entry, root));
    const entries = packageName?.trim()
      ? targetedReleaseWorkspaces(packageName, workspaces, entry => readPackage(entry, root)) : workspaces;
    const packages = entries.map(entry => testPackages.find(item => item.name === entry.name).id);
    return plan(mode, sourceSha, packages, packages.some(id => integrationPackages.has(id))
      ? suites : ["infrastructure"], [`Release verification: ${packageName?.trim() || "all release workspaces"}`]);
  }
  try {
    if (!base) throw new GitError("No base revision supplied");
    const baseSha = gitRunner(["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`]).trim();
    const mergeBase = gitRunner(["merge-base", baseSha, sourceSha]).trim();
    if (!/^[a-f\d]{40,64}$/i.test(baseSha) || !/^[a-f\d]{40,64}$/i.test(mergeBase)) {
      throw new GitError("Invalid base revision");
    }
    const paths = parseDiff(gitRunner(["diff", "--name-status", "-z", "--find-renames", mergeBase, sourceSha, "--"]));
    const graphs = [mergeBase, sourceSha].map(sha => buildGraph(testPackages,
      entry => JSON.parse(gitRunner(["show", `${sha}:${entry.directory}/package.json`]))));
    return affectedPlan(paths, graphs, sourceSha);
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    return fullPlan(mode, sourceSha, `Full fallback: ${error.message}; base/head graph or diff unavailable`);
  }
}

export function validatePlan(value) {
  if (!value || value.schemaVersion !== 1 || !["full", "affected", "release"].includes(value.mode) ||
      !/^(?:[a-f\d]{40,64}|unknown)$/i.test(value.sourceSha) || value.policy !== true ||
      typeof value.full !== "boolean" || !Array.isArray(value.reasons) || !value.reasons.length ||
      value.reasons.some(reason => typeof reason !== "string" || !reason)) throw new Error("Invalid CI plan metadata");
  for (const [field, allowed] of [["packages", allPackages], ["suites", suites]]) {
    if (!Array.isArray(value[field]) || new Set(value[field]).size !== value[field].length ||
        value[field].some(id => !allowed.includes(id))) throw new Error(`Invalid CI plan ${field}`);
  }
  if ((value.mode === "full" || value.full) &&
      (value.packages.length !== allPackages.length || value.suites.length !== suites.length || !value.full)) {
    throw new Error("Incomplete full CI plan");
  }
  if (value.mode === "release" && (value.full || !value.packages.length ||
      value.packages.includes("pi-local-notify") || !value.suites.includes("infrastructure"))) {
    throw new Error("Invalid release CI plan");
  }
  if (value.packages.some(id => integrationPackages.has(id)) &&
      !["composition", "consumers"].every(id => value.suites.includes(id))) {
    throw new Error("CI plan omits required integration suites");
  }
  return value;
}

export function tasksForPlan(value) {
  validatePlan(value);
  return ["policy", ...allPackages.filter(id => value.packages.includes(id)).map(id => `package:${id}`),
    ...suites.filter(id => value.suites.includes(id))].map(id => taskCatalog.get(id));
}

export function parsePlanArgs(args) {
  const options = {};
  let selection;
  let releaseFlag = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--shadow") { options.shadow = true; continue; }
    if (flag === "--full") {
      if (selection) throw new Error("Conflicting plan selection");
      selection = "full"; options.mode = "full"; continue;
    }
    if (flag === "--release") {
      if (releaseFlag || (selection && selection !== "release")) throw new Error("Conflicting plan selection");
      releaseFlag = true;
      selection = "release"; options.mode = "release"; continue;
    }
    const keys = { "--base": "base", "--head": "head", "--package": "packageName",
      "--output": "output", "--github-output": "githubOutput" };
    const key = keys[flag];
    if (!key || args[i + 1] === undefined || args[i + 1].startsWith("--") || key in options) {
      throw new Error(`Invalid argument: ${flag}`);
    }
    options[key] = args[++i];
    if (key === "base" || key === "packageName") {
      const mode = key === "base" ? "affected" : "release";
      if (selection && !(mode === "release" && selection === "release")) throw new Error("Conflicting plan selection");
      selection = mode; options.mode = mode;
    }
  }
  return options;
}

export function githubOutputs(value) {
  validatePlan(value);
  return Object.entries({ packages: JSON.stringify(value.packages), suites: JSON.stringify(value.suites),
    has_packages: String(value.packages.length > 0), has_suites: String(value.suites.length > 0),
    full: String(value.full), plan: JSON.stringify(value) }).map(([key, val]) => `${key}=${val}\n`).join("");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parsePlanArgs(process.argv.slice(2));
    const value = createPlan(options);
    if (options.shadow) {
      console.error(`[ci:shadow] selected ${value.packages.length}/${allPackages.length} packages, ` +
        `${value.suites.length}/${suites.length} suites; full reference retains policy, all packages and suites`);
    }
    if (options.output) writeFileSync(options.output, `${JSON.stringify(value, null, 2)}\n`);
    if (options.githubOutput) appendFileSync(options.githubOutput, githubOutputs(value));
    console.log(JSON.stringify(value, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
