import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { root } from "./workspaces.mjs";
import { targetedReleaseWorkspaces } from "./targeted-release.mjs";
import { validateReleaseBatch } from "./release-batch.mjs";

const names = Object.fromEntries(["target", "bundle", "runtime", "unrelated"].map(name => [name, `@fixture/${name}`]));
const integrity = `sha512-${createHash("sha512").update("immutable dependency").digest("base64")}`;

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "omp-targeted-release-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const scripts = join(directory, "scripts"), bin = join(directory, "bin");
  for (const path of [scripts, bin, join(directory, "release-locks")]) mkdirSync(path);
  for (const file of ["prepare-release-artifacts.mjs", "publish-release-artifacts.mjs", "release-batch.mjs",
    "release-utils.mjs", "release-dependencies.mjs", "recovery-guard.mjs", "targeted-release.mjs", "initial-codex-bootstrap.mjs"]) {
    copyFileSync(join(root, "scripts", file), join(scripts, file));
  }
  const manifests = {};
  const entries = Object.entries(names).map(([short, name]) => {
    mkdirSync(join(directory, short));
    manifests[short] = { name, version: "1.0.0", private: false, files: ["index.js"] };
    if (short === "target") manifests[short].optionalDependencies = { [names.bundle]: "1.0.0" };
    if (short === "bundle") manifests[short].dependencies = { [names.runtime]: "1.0.0" };
    writeFileSync(join(directory, short, "package.json"), JSON.stringify(manifests[short]));
    writeFileSync(join(directory, short, "index.js"), "export const original = true;\n");
    return { name, directory: short, releaseStatus: options.blocked === short ? "blocked" : "publishable" };
  });
  writeFileSync(join(scripts, "workspaces.mjs"), `
    import { readFileSync } from "node:fs";
    import { resolve } from "node:path";
    export const root = ${JSON.stringify(directory)};
    export const registry = "https://registry.npmjs.org/";
    export const workspaces = ${JSON.stringify(entries)};
    export const artifactWorkspaces = () => workspaces.filter(e => e.releaseStatus === "publishable");
    export const readManifest = directory => JSON.parse(readFileSync(resolve(root, directory, "package.json"), "utf8"));
  `);
  writeFileSync(join(directory, ".gitignore"), "release-artifacts/\nregistry.json\ncalls.log\nresult.json\n");
  writeFileSync(join(directory, "release-locks/npm-published-artifacts.json"),
    JSON.stringify({ schemaVersion: 1, registry: "https://registry.npmjs.org/", releases: {} }));
  writeFileSync(join(bin, "npm"), `#!/usr/bin/env node
const fs = require("node:fs"), cp = require("node:child_process"), crypto = require("node:crypto");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, "npm " + args.join(" ") + "\\n");
const registry = JSON.parse(fs.readFileSync(process.env.FIXTURE_REGISTRY, "utf8"));
if (args[0] === "publish") {
  const packed = JSON.parse(cp.execFileSync("tar", ["-xOf", args[1], "package/package.json"], {encoding: "utf8"}));
  registry[packed.name + "@" + packed.version] = {version: packed.version, gitHead: packed.gitHead,
    "dist.integrity": "sha512-" + crypto.createHash("sha512").update(fs.readFileSync(args[1])).digest("base64")};
  fs.writeFileSync(process.env.FIXTURE_REGISTRY, JSON.stringify(registry));
} else if (args[0] === "view" && args[2] === "version") {
  if (!registry[args[1]]) { console.error("E404"); process.exit(1); }
  console.log(JSON.stringify(registry[args[1]]));
} else if (args[0] === "view" && args[2] === "dist-tags") {
  console.log(JSON.stringify({latest: args[1] === ${JSON.stringify(names.target)} ? "1.0.0" : "9.0.0"}));
} else { console.error("Unexpected npm request"); process.exit(99); }
`);
  chmodSync(join(bin, "npm"), 0o755);
  function git(...args) {
    const child = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    return child.stdout.trim();
  }
  function commit() {
    git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture");
    return git("rev-parse", "HEAD");
  }
  git("init", "-q");
  if (options.historicalIdentity) {
    writeFileSync(join(directory, "runtime/package.json"), JSON.stringify({ ...manifests.runtime, version: "0.9.0" }));
  }
  const source = commit();
  writeFileSync(join(directory, "runtime/index.js"), "export const changed = true;\n");
  writeFileSync(join(directory, "unrelated/index.js"), "export const unrelated = true;\n");
  if (options.changedTarget) writeFileSync(join(directory, "target/index.js"), "export const changed = true;\n");
  if (options.changedMap) {
    manifests.runtime.peerDependencies = { external: "^2.0.0" };
    writeFileSync(join(directory, "runtime/package.json"), JSON.stringify(manifests.runtime));
  }
  if (options.historicalIdentity) writeFileSync(join(directory, "runtime/package.json"), JSON.stringify(manifests.runtime));
  if (options.lockMismatch) {
    writeFileSync(join(directory, "release-locks/npm-published-artifacts.json"), JSON.stringify({
      schemaVersion: 1, registry: "https://registry.npmjs.org/",
      releases: { [`${names.runtime}@1.0.0`]: { gitHead: source, integrity: "sha512-wrong" } },
    }));
  }
  const head = commit();
  const registry = Object.fromEntries(["runtime", "bundle", ...(options.recover ? ["target"] : [])].map(short => [
    `${names[short]}@1.0.0`, { version: "1.0.0", gitHead: source, "dist.integrity": integrity },
  ]));
  const registryPath = join(directory, "registry.json");
  function saveRegistry() { writeFileSync(registryPath, JSON.stringify(registry)); }
  saveRegistry();
  const env = { ...process.env, GITHUB_SHA: head, RELEASE_PACKAGE: names.target, PATH: `${bin}:${process.env.PATH}`,
    CALL_LOG: join(directory, "calls.log"), FIXTURE_REGISTRY: registryPath };
  function run(script, args = [], extraEnv = {}) {
    return spawnSync(process.execPath, [join(scripts, script), ...args], {
      cwd: directory, encoding: "utf8", timeout: 30000, env: { ...env, ...extraEnv },
    });
  }
  const artifact = join(directory, "release-artifacts/manifest.json");
  return {
    directory, source, head, registry, saveRegistry, git, manifests, entries, artifact,
    prepare: (args = [], extraEnv = {}) => run("prepare-release-artifacts.mjs", args, extraEnv),
    publish: (extraEnv = {}) => run("publish-release-artifacts.mjs", [artifact, join(directory, "result.json")], extraEnv),
    release: () => JSON.parse(readFileSync(artifact, "utf8")),
    result: () => JSON.parse(readFileSync(join(directory, "result.json"), "utf8")),
    calls: () => existsSync(env.CALL_LOG) ? readFileSync(env.CALL_LOG, "utf8") : "",
    save: release => writeFileSync(artifact, JSON.stringify(release)),
  };
}

test("targeted publication consumes changed immutable dependency workspaces but writes/releases only target", t => {
  const f = fixture(t);
  const prepared = f.prepare();
  assert.equal(prepared.status, 0, prepared.stderr);
  const release = f.release();
  assert.equal(release.requestedPackage, names.target);
  assert.deepEqual(release.candidates.map(c => [c.name, c.mode]), [
    [names.runtime, "verify"], [names.bundle, "verify"], [names.target, "publish"],
  ]);
  assert.equal(release.candidates[0].sourceCommit, f.source);
  assert.equal(release.candidates[0].filename, undefined);
  assert.equal(release.candidates[0].notes, undefined);
  const published = f.publish();
  assert.equal(published.status, 0, published.stderr);
  assert.equal(f.result().ok, true);
  assert.deepEqual(f.result().releases.map(r => r.name), [names.target]);
  assert.equal(f.calls().split("\n").filter(line => line.startsWith("npm publish ")).length, 1);
  assert.doesNotMatch(f.calls(), /@fixture\/unrelated|npm view @fixture\/(?:bundle|runtime) dist-tags/);
  assert.equal(f.git("tag"), `${names.target}@1.0.0`);
});

test("target recovery still checks its own payload and never recovers dependency workspaces", t => {
  const f = fixture(t, { recover: true });
  const prepared = f.prepare(["--package", names.target], { RELEASE_PACKAGE: "" });
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.equal(f.release().candidates.at(-1).mode, "recover");
  const published = f.publish();
  assert.equal(published.status, 0, published.stderr);
  assert.equal(f.result().ok, true);
  assert.doesNotMatch(f.calls(), /npm publish/);
  assert.equal(f.git("tag"), `${names.target}@1.0.0`);
});

for (const targeted of [true, false]) {
  test(`${targeted ? "targeted" : "full-batch"} recovery retains tarball-facing drift rejection`, t => {
    const f = fixture(t, { recover: true, changedTarget: targeted });
    const prepared = f.prepare([], targeted ? {} : { RELEASE_PACKAGE: "" });
    assert.notEqual(prepared.status, 0);
    assert.match(prepared.stderr, /current tarball-facing files changed/);
    assert.doesNotMatch(f.calls(), /npm publish/);
  });
}

for (const failure of ["unknown", "blocked", "missing", "bad-source", "bad-integrity", "wrong-identity",
  "historical-identity", "changed-map", "lock-mismatch", "conflicting-tag", "cli-mismatch"]) {
  test(`targeted preparation rejects ${failure}`, t => {
    const f = fixture(t, { blocked: failure === "blocked" ? "target" : undefined, changedMap: failure === "changed-map",
      historicalIdentity: failure === "historical-identity", lockMismatch: failure === "lock-mismatch" });
    const dependency = f.registry[`${names.runtime}@1.0.0`];
    if (failure === "missing") delete f.registry[`${names.runtime}@1.0.0`];
    if (failure === "bad-source") dependency.gitHead = "f".repeat(40);
    if (failure === "bad-integrity") dependency["dist.integrity"] = "sha512-invalid";
    if (failure === "wrong-identity") dependency.version = "2.0.0";
    if (failure === "conflicting-tag") f.git("tag", `${names.runtime}@1.0.0`, f.head);
    f.saveRegistry();
    const prepared = f.prepare(failure === "cli-mismatch" ? ["--package", names.bundle] : [],
      failure === "unknown" ? { RELEASE_PACKAGE: "@fixture/unknown" } : {});
    assert.notEqual(prepared.status, 0);
    assert.match(prepared.stderr, /Unapproved|already be published|not an ancestor|SHA-512 integrity|npm returned version|historical peerDependencies|tag .* points to|does not match RELEASE_PACKAGE|does not match package identity|does not match locked/);
    assert.equal(existsSync(f.artifact), false);
    assert.doesNotMatch(f.calls(), /npm publish/);
  });
}

for (const failure of ["missing-env", "other-env", "removed-selector", "extra-node", "missing-node", "dependency-publish",
  "dependency-recover", "target-verify", "registry-missing", "registry-integrity", "registry-source", "forged-source",
  "forged-integrity", "changed-map", "conflicting-tag"]) {
  test(`publisher rejects targeted ${failure} before registry writes`, t => {
    const f = fixture(t);
    const prepared = f.prepare();
    assert.equal(prepared.status, 0, prepared.stderr);
    const release = f.release();
    if (failure === "removed-selector") delete release.requestedPackage;
    if (failure === "extra-node") release.candidates.push({ ...release.candidates[0], name: names.unrelated, directory: "unrelated" });
    if (failure === "missing-node") release.candidates.shift();
    if (failure === "dependency-publish") release.candidates[0].mode = "publish";
    if (failure === "dependency-recover") release.candidates[0].mode = "recover";
    if (failure === "target-verify") release.candidates.at(-1).mode = "verify";
    if (failure === "registry-missing") delete f.registry[`${names.runtime}@1.0.0`];
    if (failure === "registry-integrity") f.registry[`${names.runtime}@1.0.0`]["dist.integrity"] = integrity.replace(/.$/, "A");
    if (failure === "registry-source") f.registry[`${names.runtime}@1.0.0`].gitHead = f.head;
    if (failure === "forged-source") {
      release.candidates[0].sourceCommit = "f".repeat(40);
      f.registry[`${names.runtime}@1.0.0`].gitHead = release.candidates[0].sourceCommit;
    }
    if (failure === "forged-integrity") {
      release.candidates[0].integrity = "sha512-invalid";
      f.registry[`${names.runtime}@1.0.0`]["dist.integrity"] = release.candidates[0].integrity;
    }
    if (failure === "changed-map") {
      writeFileSync(join(f.directory, "runtime/package.json"),
        JSON.stringify({ ...f.manifests.runtime, peerDependencies: { external: "^2.0.0" } }));
    }
    if (failure === "conflicting-tag") f.git("tag", `${names.runtime}@1.0.0`, f.head);
    f.saveRegistry();
    f.save(release);
    const published = f.publish(failure === "missing-env" ? { RELEASE_PACKAGE: "" }
      : failure === "other-env" ? { RELEASE_PACKAGE: names.bundle } : {});
    assert.notEqual(published.status, 0);
    assert.match(published.stderr, /does not match RELEASE_PACKAGE|exactly the requested package dependency closure|Invalid release mode|identity or integrity mismatch|tag .* points to|not an ancestor|SHA-512 integrity|historical peerDependencies/);
    assert.doesNotMatch(f.calls(), /npm publish/);
    assert.doesNotMatch(f.git("tag"), /@fixture\/target/);
  });
}

test("closure selection retains exact pins, eligibility, cycles and private-workspace guards", () => {
  const entries = ["target", "dependency"].map(name => ({ name, directory: name, releaseStatus: "publishable" }));
  const manifests = { target: { name: "target", version: "1.0.0", dependencies: { dependency: "1.0.0" } },
    dependency: { name: "dependency", version: "1.0.0" } };
  const manifestFor = entry => manifests[entry.name];
  assert.deepEqual(targetedReleaseWorkspaces("target", entries, manifestFor).map(e => e.name), ["dependency", "target"]);
  manifests.target.dependencies.dependency = "^1.0.0";
  assert.throws(() => targetedReleaseWorkspaces("target", entries, manifestFor), /exactly pinned/);
  manifests.target.dependencies.dependency = "1.0.0";
  manifests.dependency.private = true;
  assert.throws(() => targetedReleaseWorkspaces("target", entries, manifestFor), /Invalid release workspace identity/);
  delete manifests.dependency.private;
  entries[1].releaseStatus = "bootstrap";
  assert.throws(() => targetedReleaseWorkspaces("target", entries, manifestFor), /Unapproved/);
  entries[1].releaseStatus = "publishable";
  manifests.dependency.dependencies = { target: "1.0.0" };
  assert.throws(() => targetedReleaseWorkspaces("target", entries, manifestFor), /cycle/);
  assert.throws(() => validateReleaseBatch([{ name: "target", directory: "target", version: "1.0.0", mode: "verify" }],
    entries, manifestFor), /Invalid release mode/);
});
