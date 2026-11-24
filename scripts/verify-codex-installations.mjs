import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import semver from "semver";
import { piVersion } from "./pi-version.mjs";
import { root, readManifest } from "./workspaces.mjs";
import { isolatedConsumerLock } from "./isolated-consumer-lock.mjs";
import { readPnpmLock, writePnpmLock } from "./pnpm-lock.mjs";
import { codexConsumerMatrix, incompatibleRuntimeLines, sourceConsumerSelection } from "./codex-consumer-matrix.mjs";

const matrix = codexConsumerMatrix(process.env.OMP_CODEX_CONSUMER_MODE);
console.log(`Codex consumer mode: ${matrix.mode}; packing all seven packages; ${matrix.consumers.length} consumer cases`);
const prefix = "@oai404iao/";
const names = ["pi-codex-runtime", "pi-codex-core", "pi-codex-tools", "pi-codex-web-search", "pi-codex-imagegen", "pi-codex-minimal-tools", "pi-subagent"];
const manifests = new Map(names.map(name => [prefix + name, readManifest(`pi-extensions/${name}`)]));
// pnpm may choose another store when the OS temporary directory is on a
// different filesystem. Offline fixtures must reuse the root install's store.
const storeDirectory = pnpm(["store", "path", "--silent"], root).trim();
const directory = mkdtempSync(join(tmpdir(), "codex-tarball-consumers-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousFetch = globalThis.fetch;
const rejectNetwork = async () => { throw new Error("Unexpected HTTP request outside a Codex fixture"); };
globalThis.fetch = rejectNetwork;
process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
const packed = new Map();
const consumers = new Map();
const runtimeVersions = new Map();
const sourceLock = readPnpmLock(join(root, "pnpm-lock.yaml"));
let checks = 0;
let skipped = 0;

function pnpm(args, cwd) {
  const result = spawnSync("pnpm", args, {
    cwd, encoding: "utf8", timeout: 90000,
    env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" },
  });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function assertContainedTree(path, consumer, omitOptional = false) {
  for (const entry of readdirSync(path)) {
    const file = join(path, entry);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) {
      try {
        assert.ok(realpathSync(file).startsWith(`${consumer}/`), `external link: ${file}`);
      } catch (error) {
        const store = join(consumer, "node_modules/.pnpm");
        if (error.code !== "ENOENT" || !omitOptional
          || file !== join(store, "node_modules/@oai404iao/pi-codex-runtime")) throw error;
        // pnpm can retain this hoisted link when --no-optional omits its
        // runtime snapshot. Its target must still stay inside this consumer.
        const target = resolve(dirname(file), readlinkSync(file));
        assert.ok(target.startsWith(`${store}/`), `external omitted runtime link: ${file}`);
        const parts = target.slice(store.length + 1).split("/");
        assert.ok(parts.length === 4 && parts[0].startsWith("@oai404iao+pi-codex-runtime@")
          && parts.slice(1).join("/") === "node_modules/@oai404iao/pi-codex-runtime",
        `unexpected omitted runtime target: ${target}`);
        let ancestor = dirname(target);
        for (;;) {
          try { lstatSync(ancestor); break; }
          catch (missing) { if (missing.code !== "ENOENT") throw missing; }
          ancestor = dirname(ancestor);
        }
        assert.ok(realpathSync(ancestor).startsWith(`${consumer}/`), `external omitted runtime ancestor: ${ancestor}`);
      }
    } else if (stat.isDirectory()) assertContainedTree(file, consumer, omitOptional);
  }
}

function install(label, requested, selectedManifests = manifests, archives = packed) {
  const omitOptional = label === "subagent-no-optional";
  const path = join(directory, label);
  const { included, resolutions } = sourceConsumerSelection(requested.map(name => prefix + name), selectedManifests, sourceLock);
  const registryEdges = new Set(resolutions.map(({ owner, dependency }) => `${owner}>${dependency}`));
  for (const { owner, dependency, version, range, sourceVersion } of resolutions) {
    console.log(`Frozen registry dependency (${label}): ${owner} -> ${dependency}@${version} (requires ${range}, checkout ${sourceVersion})`);
  }
  const consumer = isolatedConsumerLock(`fixture-${label}`, included, selectedManifests, archives, sourceLock, registryEdges);
  const artifacts = Object.entries(consumer.lock.packages).filter(([key]) => key.startsWith(prefix));
  const packageName = key => key.slice(0, key.indexOf("@", 1));
  const runtime = prefix + "pi-codex-runtime";
  const versions = artifacts.filter(([key]) => packageName(key) === runtime).map(([key, entry]) => entry.version ?? key.slice(runtime.length + 1));
  if (requested.length > 1 && incompatibleRuntimeLines(versions)) {
    console.log(`SKIP unsupported combined roots ${label}: resolved incompatible runtime versions ${versions.join(", ")}`);
    skipped++;
    return undefined;
  }
  runtimeVersions.set(label, versions);
  const expected = new Set([...requested, "pi-codex-runtime"]);
  if (requested.some(name => ["pi-codex-web-search", "pi-codex-imagegen"].includes(name))) expected.add("pi-codex-tools");
  if (requested.includes("pi-codex-minimal-tools")) {
    for (const name of ["pi-codex-core", "pi-codex-tools"]) expected.add(name);
  }
  assert.deepEqual([...new Set(artifacts.map(([key]) => packageName(key)))].sort(), [...expected].map(name => prefix + name).sort(),
    "the installed dependency closure must match unified tools and compatibility entries");
  mkdirSync(path);
  const installed = new Set(included);
  if (omitOptional) {
    // Keep the real optional edge and tarball snapshot in the frozen lock, but
    // do not promote runtime to a direct production dependency of the fixture.
    assert.ok(manifests.get(prefix + "pi-subagent").optionalDependencies?.[runtime]);
    delete consumer.manifest.dependencies[runtime];
    delete consumer.lock.importers["."].dependencies[runtime];
    installed.delete(runtime);
  }
  writeFileSync(join(path, "package.json"), JSON.stringify(consumer.manifest));
  writeFileSync(join(path, "pnpm-workspace.yaml"), stringify(consumer.workspace));
  writePnpmLock(join(path, "pnpm-lock.yaml"), consumer.lock);
  // The projection already validates reviewed artifact identities. pnpm 12's
  // policy recheck otherwise needs registry metadata even for a frozen lock.
  pnpm(["install", "--store-dir", storeDirectory, "--frozen-lockfile", "--offline", "--trust-lockfile", "--ignore-scripts", "--prod", ...(omitOptional ? ["--no-optional"] : [])], path);
  if (omitOptional) {
    const hoisted = join(path, "node_modules/.pnpm/node_modules/@oai404iao/pi-codex-runtime");
    try { lstatSync(hoisted); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      // Exercise pnpm's dangling optional-hoist shape even on installations
      // that do not retain the link; no runtime snapshot is materialized.
      mkdirSync(dirname(hoisted), { recursive: true });
      symlinkSync("../../@oai404iao+pi-codex-runtime@omitted-fixture/node_modules/@oai404iao/pi-codex-runtime", hoisted);
    }
  }
  assertContainedTree(join(path, "node_modules"), path, omitOptional);
  assert.deepEqual(readdirSync(join(path, "node_modules/@oai404iao")).sort(), [...installed].map(n => n.slice(prefix.length)).sort());
  for (const name of installed) {
    assert.ok(realpathSync(join(path, "node_modules", name)).startsWith(path), `${name} leaked from the workspace`);
  }
  if (!omitOptional) for (const { owner, dependency, version } of resolutions) {
    const anchor = realpathSync(join(path, "node_modules", owner, "package.json"));
    const resolved = createRequire(anchor).resolve.paths(dependency).map(dir => join(dir, dependency, "package.json")).find(existsSync);
    assert.ok(resolved && realpathSync(resolved).startsWith(`${path}/`), `missing isolated dependency ${owner} -> ${dependency}`);
    const actual = JSON.parse(readFileSync(resolved));
    assert.equal(actual.name, dependency);
    assert.equal(actual.version, version, `${owner} must resolve its locked dependency, not a checkout override`);
  }
  if (label === "bundle") {
    const require = createRequire(join(path, "package.json"));
    assert.throws(() => require.resolve(`${prefix}pi-codex-minimal-tools/subagent-inline`), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
  }
  if (label === "runtime") {
    const smoke = join(path, "runtime-smoke.mts");
    writeFileSync(smoke, `
      import assert from "node:assert/strict";
      import { CODEX_RUNTIME_VERSION, getCodexBroker } from "@oai404iao/pi-codex-runtime";
      import { CODEX_IDENTITY_CUSTOM_TYPE, createCodexSubagentInlineExtension } from "@oai404iao/pi-codex-runtime/subagent-inline";
      const pi = { on() {} };
      const broker = getCodexBroker(pi);
      assert.equal(getCodexBroker(pi), broker);
      assert.equal(broker.runtimeVersion, ${JSON.stringify(selectedManifests.get(prefix + "pi-codex-runtime").version)});
      assert.equal(broker.acceptsRuntime(CODEX_RUNTIME_VERSION), true);
      assert.equal(typeof CODEX_IDENTITY_CUSTOM_TYPE, "string");
      assert.equal(typeof createCodexSubagentInlineExtension, "function");
    `);
    const smokeResult = spawnSync(join(root, "node_modules/.bin/tsx"), [smoke], {
      cwd: path, encoding: "utf8", timeout: 45000,
    });
    assert.equal(smokeResult.status, 0, smokeResult.stdout + smokeResult.stderr);
  }
  consumers.set(label, path);
  return path;
}

function pack(cwd) {
  const result = JSON.parse(pnpm(["pack", "--json", "--config.ignore-scripts=true", "--pack-destination", directory], cwd));
  const path = resolve(directory, result.filename);
  return { path, integrity: `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}` };
}

function mixedRuntimeProbes() {
  const name = prefix + "pi-codex-runtime";
  const source = manifests.get(name);
  // Exercise the ABI, not registry resolution: these are two explicitly
  // versioned builds of this source, not evidence about historical releases.
  const first = semver.inc(source.version, "patch");
  const versions = [first, semver.inc(first, "minor")];
  const paths = versions.map(version => {
    const build = join(directory, `runtime-source-${version}`);
    mkdirSync(build);
    const extracted = spawnSync("tar", ["-xzf", packed.get(name).path, "-C", build, "--strip-components=1"], { encoding: "utf8" });
    assert.equal(extracted.status, 0, extracted.stderr);
    const path = join(build, "package.json");
    const manifest = { ...JSON.parse(readFileSync(path)), version };
    writeFileSync(path, JSON.stringify(manifest));
    return install(`runtime-${version}`, ["pi-codex-runtime"], new Map([[name, manifest]]), new Map([[name, pack(build)]]));
  });
  const result = spawnSync(process.execPath, [join(root, "tests/codex/support/packed-runtime-probe.mjs"), piVersion, ...versions, ...paths], {
    cwd: directory, encoding: "utf8", timeout: 90000, env: { ...process.env, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  console.log(`✓ Pi loader: source-built runtime variants ${versions.join(" / ")}, both owners, cache, inline identity/Fast, incompatible ABI`);
  checks += 2;
}

function runProbes(label, orders, expectedTools, core) {
  const job = join(directory, "probe.json");
  writeFileSync(job, JSON.stringify({
    version: piVersion,
    probes: orders.map(paths => ({ label, cwd: consumers.get(label), paths, expectedTools, core })),
  }));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./codex-loader-probe.mjs", import.meta.url)), job], {
    cwd: root, encoding: "utf8", timeout: 90000,
    env: { ...process.env, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  checks += orders.length;
}

try {
  mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  for (const name of names) {
    packed.set(prefix + name, pack(join(root, "pi-extensions", name)));
  }
  for (const [label, requested, tools, core] of matrix.consumers) {
    const path = install(label, requested);
    if (!path) continue;
    if (requested.includes("pi-subagent")) {
      const result = spawnSync(process.execPath, [fileURLToPath(new URL("./subagent-consumer-probe.mjs", import.meta.url)), path, piVersion, label], {
        cwd: path, encoding: "utf8", timeout: 90000,
        env: { ...process.env, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_CODING_AGENT_DIR: join(path, "agent") },
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      checks++;
      rmSync(path, { recursive: true, force: true });
      continue;
    }
    const entries = requested.flatMap(name =>
      (manifests.get(prefix + name).pi?.extensions ?? []).map(entry => join(path, "node_modules", prefix + name, entry)));
    runProbes(label, matrix.reverseOrders && entries.length > 1 ? [entries, [...entries].reverse()] : [entries], tools, core);
    if (!["bundle", "web", "tools"].includes(label)) rmSync(path, { recursive: true, force: true });
  }
  if (matrix.capabilityMasks.length > 0) {
    const configDirectory = join(process.env.PI_CODING_AGENT_DIR, "extensions", "pi-codex-minimal-tools");
    mkdirSync(configDirectory, { recursive: true });
    const toolsEntry = join(consumers.get("tools"), "node_modules", prefix + "pi-codex-tools/index.ts");
    for (const mask of matrix.capabilityMasks) {
      const enabled = [Boolean(mask & 1), Boolean(mask & 2), Boolean(mask & 4)];
      writeFileSync(join(configDirectory, "config.json"), JSON.stringify({
        applyPatch: enabled[0], webSearch: enabled[1], imageGeneration: enabled[2],
      }));
      runProbes("tools", [[toolsEntry]], ["apply_patch", "web_search", "image_generation"].filter((_, index) => enabled[index]), false);
    }
    writeFileSync(join(configDirectory, "config.json"), "{}");
  }
  if (matrix.separateRuntimeCopies) {
    // Physically separate runtime copies, not merely different API wrappers.
    const bundle = join(consumers.get("bundle"), "node_modules", prefix + "pi-codex-minimal-tools/index.ts");
    const web = join(consumers.get("web"), "node_modules", prefix + "pi-codex-web-search/index.ts");
    const allTools = ["apply_patch", "web_search", "image_generation"];
    const versions = [...runtimeVersions.get("bundle"), ...runtimeVersions.get("web")];
    if (incompatibleRuntimeLines(versions)) {
      console.log(`SKIP unsupported bundle/web mixed roots: resolved incompatible runtime versions ${versions.join(", ")}`);
      skipped++;
    } else runProbes("bundle", [[bundle, web], [web, bundle]], allTools, true);
    mixedRuntimeProbes();
  }
  console.log(`✓ Codex (${matrix.mode}): ${checks} production tarball/Pi ${piVersion} combinations; ${skipped} out-of-range source case(s) skipped; frozen offline pnpm install; no external links or capability leakage`);
} finally {
  globalThis.fetch = previousFetch;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(directory, { recursive: true, force: true });
}
