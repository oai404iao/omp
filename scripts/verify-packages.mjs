import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readManifest, registry, root, workspaces } from "./workspaces.mjs";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const lock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8"));

const errors = [];
const seenNames = new Set();
const testedPiVersion = "0.84.2";
const exactPiPeerPackages = new Set(["@oai404iao/pi-tree-continue"]);
const requiredPiDependencies = {
  "@oai404iao/pi-tree-continue": {
    "@earendil-works/pi-coding-agent": {
      peer: testedPiVersion,
      dev: testedPiVersion,
    },
  },
};
const requiredRuntimeFiles = {
  "@oai404iao/pi-external-thinking": ["THIRD_PARTY_NOTICES.md"],
  "@oai404iao/pi-codex-minimal-tools": [
    "LICENSES/Apache-2.0.txt",
    "LICENSES/OpenAI-Codex-NOTICE.txt",
    "THIRD_PARTY_NOTICES.md",
    "config.schema.json",
    "models.schema.json",
    "src/model-catalog/default-models.json",
    "src/providers/codex-apply-patch.lark",
  ],
  "@oai404iao/pi-keep-defaults": [],
  "@oai404iao/pi-subagent": [
    "agents/planner.md",
    "agents/reviewer.md",
    "agents/scout.md",
    "agents/worker.md",
    "config.example.json",
    "config.schema.json",
  ],
  "@oai404iao/pi-telegram-notify": ["config.example.json", "config.schema.json"],
  "@oai404iao/pi-tree-continue": [],
};

function report(message) {
  errors.push(message);
}

function normalizePackagePath(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function parsePackOutput(name, stdout) {
  try {
    const output = JSON.parse(stdout);
    if (!Array.isArray(output) || output.length !== 1 || !Array.isArray(output[0]?.files)) {
      throw new Error("unexpected npm pack JSON shape");
    }
    return output[0];
  } catch (error) {
    report(`${name}: could not parse npm pack output: ${error.message}`);
    return undefined;
  }
}

for (const { name: expectedName, directory, releaseStatus } of workspaces) {
  const manifest = readManifest(directory);

  if (!["blocked", "publishable"].includes(releaseStatus)) {
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
  if (!Array.isArray(manifest.keywords) || !manifest.keywords.includes("pi-package")) {
    report(`${manifest.name}: keywords must include pi-package`);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    report(`${manifest.name}: files must be a non-empty allowlist`);
  } else if (!manifest.files.includes("LICENSE")) {
    report(`${manifest.name}: files allowlist must explicitly include LICENSE`);
  }
  if (!Array.isArray(manifest.pi?.extensions) || manifest.pi.extensions.length === 0) {
    report(`${manifest.name}: pi.extensions must contain at least one entry`);
  }
  const exactPiPeerRange = exactPiPeerPackages.has(manifest.name);
  const expectedPiPeerRange = exactPiPeerRange ? testedPiVersion : `>=${testedPiVersion}`;
  const expectedPiDevBaseline = exactPiPeerRange ? testedPiVersion : `^${testedPiVersion}`;
  for (const [dependency, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (!dependency.startsWith("@earendil-works/pi-")) continue;
    if (range !== expectedPiPeerRange) {
      report(`${manifest.name}: ${dependency} peer range must be ${expectedPiPeerRange}`);
    }
    if (manifest.devDependencies?.[dependency] !== expectedPiDevBaseline) {
      report(`${manifest.name}: ${dependency} development baseline must be ${expectedPiDevBaseline}`);
    }
  }
  for (const [dependency, expected] of Object.entries(requiredPiDependencies[manifest.name] ?? {})) {
    if (manifest.peerDependencies?.[dependency] !== expected.peer) {
      report(`${manifest.name}: ${dependency} peer dependency must be ${expected.peer}`);
    }
    if (manifest.devDependencies?.[dependency] !== expected.dev) {
      report(`${manifest.name}: ${dependency} development dependency must be ${expected.dev}`);
    }
  }
  if (
    manifest.name === "@oai404iao/pi-codex-minimal-tools"
    && manifest.dependencies?.undici !== "^8.10.0"
  ) {
    report("@oai404iao/pi-codex-minimal-tools: undici must remain on the audited ^8.10.0 baseline");
  }
  if (
    manifest.publishConfig?.access !== "public"
    || manifest.publishConfig?.registry !== registry
  ) {
    report(`${manifest.name}: publishConfig must target the public npm registry`);
  }
  if (lock.packages?.[directory]?.version !== manifest.version) {
    report(
      `${manifest.name}: package-lock workspace version ${String(lock.packages?.[directory]?.version)} does not match ${manifest.version}`,
    );
  }

  const packed = spawnSync(
    npm,
    ["pack", "--dry-run", "--json", "--ignore-scripts", "--workspace", expectedName],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, npm_config_loglevel: "error" },
    },
  );

  if (packed.status !== 0) {
    report(`${manifest.name}: npm pack failed: ${(packed.stderr || packed.stdout).trim()}`);
    continue;
  }

  const packOutput = parsePackOutput(manifest.name, packed.stdout);
  if (!packOutput) continue;

  const packedPaths = new Set(packOutput.files.map((file) => normalizePackagePath(file.path)));
  for (const required of [
    "package.json",
    "README.md",
    "LICENSE",
    ...(requiredRuntimeFiles[expectedName] ?? []),
  ]) {
    if (!packedPaths.has(required)) report(`${manifest.name}: tarball is missing ${required}`);
  }
  for (const extension of manifest.pi.extensions ?? []) {
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
      || /^(?:test|tests|reference)\//.test(path)
    ) {
      report(`${manifest.name}: development-only path would be published: ${path}`);
    }
  }

  const unpackedSize = Number(packOutput.unpackedSize ?? 0);
  console.log(
    `✓ ${manifest.name}@${manifest.version} [${releaseStatus}]: ${packedPaths.size} files, ${unpackedSize.toLocaleString()} bytes unpacked`,
  );
}

if (errors.length > 0) {
  console.error("\nPackage verification failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
}
