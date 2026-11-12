import { spawnSync } from "node:child_process";
import { globSync, mkdirSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { readManifest, registry, root, workspaces } from "./workspaces.mjs";
import { piFloor, piVersion } from "./pi-baselines.mjs";
import { readPnpmLock } from "./pnpm-lock.mjs";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const lock = readPnpmLock(resolve(root, "pnpm-lock.yaml"));
const scratch = resolve(process.env.HOME, ".local/state/agents/tmp");
mkdirSync(scratch, { recursive: true });
const packDirectory = mkdtempSync(resolve(scratch, "omp-pack-check-"));

const errors = [];
const seenNames = new Set();
const testedPiVersion = piFloor;

function report(message) {
  errors.push(message);
}

function normalizePackagePath(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function parsePackOutput(name, stdout) {
  try {
    const output = JSON.parse(stdout);
    if (!output || !Array.isArray(output.files)) {
      throw new Error("unexpected pnpm pack JSON shape");
    }
    return output;
  } catch (error) {
    report(`${name}: could not parse pnpm pack output: ${error.message}`);
    return undefined;
  }
}

for (const { name: expectedName, directory, releaseStatus, kind } of workspaces) {
  const manifest = readManifest(directory);

  if (!["blocked", "bootstrap", "publishable"].includes(releaseStatus)) {
    report(`${expectedName}: unknown releaseStatus ${String(releaseStatus)}`);
  }
  if (manifest.name !== expectedName) {
    report(`${directory}: expected package name ${expectedName}, found ${String(manifest.name)}`);
  }
  if (seenNames.has(manifest.name)) report(`${directory}: duplicate package name ${manifest.name}`);
  seenNames.add(manifest.name);

  const expectedPrivate = releaseStatus === "blocked";
  if ((manifest.private === true) !== expectedPrivate) {
    report(
      `${manifest.name}: releaseStatus=${releaseStatus} must ${expectedPrivate ? "" : "not "}set private=true`,
    );
  }
  if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    report(`${manifest.name}: invalid SemVer version ${String(manifest.version)}`);
  }
  if (typeof manifest.license !== "string" || manifest.license.length === 0) {
    report(`${manifest.name}: package.json must declare a license identifier`);
  }
  if (kind !== "library" && (!Array.isArray(manifest.keywords) || !manifest.keywords.includes("pi-package"))) {
    report(`${manifest.name}: keywords must include pi-package`);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    report(`${manifest.name}: files must be a non-empty allowlist`);
  } else if (!manifest.files.includes("LICENSE")) {
    report(`${manifest.name}: files allowlist must explicitly include LICENSE`);
  }
  if (kind !== "library" && (!Array.isArray(manifest.pi?.extensions) || manifest.pi.extensions.length === 0)) {
    report(`${manifest.name}: pi.extensions must contain at least one entry`);
  }
  if (
    kind !== "library"
    && Array.isArray(manifest.pi?.extensions)
    && manifest.pi.extensions.length > 0
    && (
      manifest.pi.extensions.length !== 1
      || normalizePackagePath(manifest.pi.extensions[0]) !== "index.ts"
    )
  ) {
    report(`${manifest.name}: pi.extensions must contain only ./index.ts`);
  }
  if (kind === "library" && manifest.pi?.extensions?.length) {
    report(`${manifest.name}: runtime library must not auto-register Pi extensions`);
  }
  const expectedPiPeerRange = `>=${testedPiVersion}`;
  const expectedPiDevBaseline = piVersion();
  for (const [dependency, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (!dependency.startsWith("@earendil-works/pi-")) continue;
    if (range !== expectedPiPeerRange) {
      report(`${manifest.name}: ${dependency} peer range must be ${expectedPiPeerRange}`);
    }
    if (manifest.devDependencies?.[dependency] !== expectedPiDevBaseline) {
      report(`${manifest.name}: ${dependency} development baseline must be ${expectedPiDevBaseline}`);
    }
  }
  if (
    manifest.name === "@oai404iao/pi-codex-core"
    && manifest.dependencies?.undici !== "^8.12.3"
  ) {
    report("@oai404iao/pi-codex-core: undici must remain on the audited ^8.12.3 baseline");
  }
  if (
    manifest.publishConfig?.access !== "public"
    || manifest.publishConfig?.registry !== registry
  ) {
    report(`${manifest.name}: publishConfig must target the public npm registry`);
  }
  const importer = lock.importers?.[directory];
  if (!importer) report(`${manifest.name}: missing pnpm lockfile importer`);
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
      if (importer?.[field]?.[name]?.specifier !== specifier) {
        report(`${manifest.name}: pnpm lockfile ${field}.${name} does not match ${specifier}`);
      }
    }
  }

  const packed = spawnSync(
    pnpm,
    ["--dir", directory, "pack", "--pack-destination", packDirectory, "--json", "--ignore-scripts"],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, npm_config_loglevel: "error" },
    },
  );

  if (packed.status !== 0) {
    report(`${manifest.name}: pnpm pack failed: ${(packed.stderr || packed.stdout).trim()}`);
    continue;
  }

  const packOutput = parsePackOutput(manifest.name, packed.stdout);
  if (!packOutput) continue;

  const packedPaths = new Set(packOutput.files.map((file) => normalizePackagePath(file.path)));
  const archive = spawnSync("tar", ["-tzf", resolve(packDirectory, packOutput.filename)], { encoding: "utf8" });
  if (archive.status !== 0) {
    report(`${manifest.name}: cannot inspect actual archive: ${archive.stderr}`);
    continue;
  }
  const archivePaths = archive.stdout.trim().split("\n").filter(path => !path.endsWith("/"))
    .map(path => path.replace(/^package\//, "")).sort();
  if (JSON.stringify(archivePaths) !== JSON.stringify([...packedPaths].sort())) {
    report(`${manifest.name}: actual tarball differs from pack file listing`);
  }
  const packageRoot = resolve(root, directory);
  const expectedPaths = new Set(["package.json", "README.md", "LICENSE"]);
  for (const pattern of manifest.files ?? []) {
    const matches = [...globSync(pattern.replace(/\/$/, ""), { cwd: packageRoot })];
    if (!matches.length) report(`${manifest.name}: files entry matches nothing: ${pattern}`);
    for (const path of matches) {
      if (statSync(resolve(packageRoot, path)).isDirectory()) {
        for (const entry of readdirSync(resolve(packageRoot, path), { recursive: true, withFileTypes: true })) {
          if (entry.isFile()) expectedPaths.add(normalizePackagePath(
            `${entry.parentPath.slice(packageRoot.length + 1)}/${entry.name}`));
        }
      } else expectedPaths.add(normalizePackagePath(path));
    }
  }
  for (const path of expectedPaths) {
    if (!packedPaths.has(path)) report(`${manifest.name}: tarball is missing declared file ${path}`);
  }
  for (const path of packedPaths) {
    if (!expectedPaths.has(path)) report(`${manifest.name}: tarball contains undeclared file ${path}`);
  }
  for (const extension of manifest.pi?.extensions ?? []) {
    const entry = normalizePackagePath(extension);
    if (!packedPaths.has(entry)) {
      report(`${manifest.name}: Pi extension entry ${entry} is not present in the tarball`);
    }
  }

  for (const path of packedPaths) {
    if (path.startsWith("/") || path.split("/").includes("..")) {
      report(`${manifest.name}: unsafe tarball path ${path}`);
    }
    if (
      /(^|\/)(?:node_modules|\.git)(?:\/|$)/i.test(path)
      || /(^|\/)\.env(?:\.|$)/i.test(path)
      || /(^|\/)(?:config|credentials?|auth)\.json$/i.test(path)
      || /\.(?:pem|p12|pfx|key)$/i.test(path)
    ) {
      report(`${manifest.name}: sensitive or local-only path would be published: ${path}`);
    }
    if (
      path === "tsconfig.json"
      || /(^|\/)(?:test|tests|reference)\//.test(path)
      || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)
      || /(^|\/)AGENTS\.md$/i.test(path)
      || /^docs\/(?:audits|plans)\//.test(path)
    ) {
      report(`${manifest.name}: development-only path would be published: ${path}`);
    }
  }

  console.log(
    `✓ ${manifest.name}@${manifest.version} [${releaseStatus}]: ${packedPaths.size} files`,
  );
}

if (errors.length > 0) {
  console.error("\nPackage verification failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
}
