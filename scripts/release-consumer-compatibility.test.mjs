import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readPnpmLock } from "./pnpm-lock.mjs";
import { canonicalTarball, digest } from "./release-consumer-artifacts.mjs";
import { verifyCompatibility } from "./release-consumer-compatibility.mjs";
import { latestConsumerEntries } from "./release-consumer-compatibility-history.mjs";
import { registry, root } from "./workspaces.mjs";

const library = "@oai404iao/library", extension = "@oai404iao/extension", pinned = "@oai404iao/pinned";
const entry = name => ({ name, directory: `pi-extensions/${name.split("/")[1]}`, releaseStatus: "publishable" });
const peerDependencies = { "@earendil-works/pi-coding-agent": ">=1.5.2" };
function fixture(t) {
  const parent = join(homedir(), ".local/state/agents/tmp"); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, "release-compatibility-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const versions = new Map();
  function pack(manifest, code, mode) {
    manifest = { type: "module", peerDependencies, ...manifest };
    const { name, version } = manifest;
    const sourceCommit = (versions.size + 1).toString().repeat(40);
    const dir = join(directory, `archive-${versions.size}`); mkdirSync(join(dir, "package"), { recursive: true });
    writeFileSync(join(dir, "package/package.json"), JSON.stringify({ ...manifest, gitHead: sourceCommit }));
    writeFileSync(join(dir, "package/index.js"), code);
    const path = `${dir}.tgz`; execFileSync("tar", ["-czf", path, "package/"], { cwd: dir });
    const integrity = digest(readFileSync(path));
    const candidate = { name, version, directory: entry(name).directory, sourceCommit, integrity, mode, tag: `${name}@${version}` };
    const subject = { candidate, manifest, file: { path, integrity } };
    versions.set(candidate.tag, subject);
    return subject;
  }
  function verify(batch, latest) {
    const entries = [...new Set([...versions.values()].map(x => x.candidate.name))].map(entry);
    return verifyCompatibility({ candidates: batch.map(x => x.candidate), manifests: new Map(batch.map(x => [x.candidate.name, x.manifest])),
      artifacts: new Map(batch.map(x => [x.candidate.name, x.file])), lock: readPnpmLock(join(root, "pnpm-lock.yaml")),
      commit: "e".repeat(40), directory, entries, inventory: () => entries.filter(e => Object.hasOwn(latest, e.name)), latestTag: name => latest[name],
      // The checkout alone does not even know about these historical dependency edges.
      checkout: e => ({ name: e.name, version: "99.0.0" }), resolution: {
        versions: name => [...versions.values()].filter(x => x.candidate.name === name && x.candidate.mode === "verify").map(x => x.candidate.version),
        lookup: (name, version) => {
        const c = versions.get(`${name}@${version}`)?.candidate;
        return c ? { exists: true, gitHead: c.sourceCommit, integrity: c.integrity } : { exists: false };
      }, check: c => versions.get(c.tag).manifest },
      acquisition: { checkPublished: c => assert.equal(versions.get(c.tag).candidate.integrity, c.integrity), transport: async url => {
        for (const { candidate: c, file } of versions.values()) {
          if (url === canonicalTarball(c)) return new Response(readFileSync(file.path));
          if (url === `${registry}${encodeURIComponent(c.name)}/${c.version}`) return Response.json({ name: c.name, version: c.version,
            gitHead: c.sourceCommit, dist: { integrity: c.integrity, tarball: canonicalTarball(c) } });
        }
        throw new Error(`Unexpected registry read: ${url}`);
      } } });
  }
  return { pack, verify };
}

const lib = version => ({ name: library, version, exports: "./index.js" });
const consumer = version => ({ name: extension, version, optionalDependencies: { [library]: "^1.0.0" }, pi: { extensions: ["./index.js"] } });
const requireMarker = marker => `import { marker } from '${library}'; export default () => { if (marker !== '${marker}') throw new Error('wrong immutable library bytes: ' + marker); }`;

test("new package alone really loads the latest admitting published optional consumer, not a checkout replacement or an old exact pin", async t => {
  const f = fixture(t);
  const candidate = f.pack(lib("1.2.0"), 'export const marker = "new";', "publish");
  f.pack(consumer("1.4.0"), requireMarker("new"), "verify");
  f.pack({ ...consumer("1.0.0"), name: pinned, optionalDependencies: { [library]: "1.0.0" } }, 'throw new Error("never override an old pin")', "verify");
  const { checks } = await f.verify([candidate], { [extension]: "1.4.0", [pinned]: "1.0.0" });
  assert.equal(checks.length, 2);
  const loaded = checks.find(c => c.requested === extension);
  assert.equal(loaded.status, "installed"); assert.equal(loaded.artifacts.find(c => c.name === library).integrity, candidate.file.integrity);
  assert.equal(checks.find(c => c.requested === pinned).status, "outside-declared-range");
});

test("a published consumer can resolve a different admitted transitive dependency than the candidate's base install", async t => {
  const f = fixture(t), abi = "@oai404iao/abi", shim = "@oai404iao/shim";
  const candidate = f.pack({ ...lib("1.2.0"), dependencies: { [abi]: "^3.0.0" } }, `export { marker } from '${abi}';`, "publish");
  const selected = f.pack({ ...lib("3.1.5"), name: abi }, 'export const marker = "recent";', "verify");
  const old = f.pack({ ...lib("3.0.0"), name: abi }, 'export const marker = "historical";', "verify");
  f.pack({ name: shim, version: "1.0.0", dependencies: { [abi]: "3.0.0" } }, "", "verify");
  f.pack({ ...consumer("1.4.0"), dependencies: { [shim]: "1.0.0" } }, requireMarker("historical"), "verify");
  const { checks } = await f.verify([candidate, selected], { [extension]: "1.4.0" });
  const loaded = checks.find(c => c.requested === extension);
  assert.equal(loaded.status, "installed");
  assert.equal(loaded.artifacts.find(c => c.name === abi).integrity, old.file.integrity);
});

test("an authorized but not yet published transitive minimum can participate in the installed migration batch", async t => {
  const f = fixture(t), abi = "@oai404iao/abi";
  const candidate = f.pack({ ...lib("1.2.0"), dependencies: { [abi]: "^3.2.0" } }, `export { marker } from '${abi}';`, "publish");
  const pending = f.pack({ ...lib("3.2.0"), name: abi }, 'export const marker = "pending";', "publish");
  f.pack(consumer("1.4.0"), requireMarker("pending"), "verify");
  const { checks } = await f.verify([candidate, pending], { [extension]: "1.4.0" });
  assert.equal(checks.find(c => c.requested === extension).artifacts.find(c => c.name === abi).integrity, pending.file.integrity);
});

test("inventory retains removed optional edges and never needs registry metadata of historically unrelated workspaces", t => {
  const parent = join(homedir(), ".local/state/agents/tmp"); mkdirSync(parent, { recursive: true });
  const cwd = mkdtempSync(join(parent, "release-compatibility-history-")); t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-c", "user.email=fixture@invalid", "-c", "user.name=fixture", ...args], { cwd, encoding: "utf8" }).trim();
  git("init", "--quiet");
  const entries = [library, extension, pinned].map(entry);
  for (const e of entries) {
    mkdirSync(join(cwd, e.directory), { recursive: true });
    writeFileSync(join(cwd, e.directory, "package.json"), JSON.stringify({ name: e.name, description: `历史 ${library}`,
      ...(e.name === extension && { optionalDependencies: { [library]: "^1.0.0" } }) }));
  }
  git("add", "."); git("commit", "--quiet", "-m", "old contracts");
  writeFileSync(join(cwd, entry(extension).directory, "package.json"), JSON.stringify({ name: extension }));
  git("commit", "--quiet", "-am", "remove optional edge before new library release");
  const head = git("rev-parse", "HEAD");
  assert.deepEqual(latestConsumerEntries([{ name: library, mode: "publish" }], entries, head, cwd), [entry(extension)]);
  assert.deepEqual(latestConsumerEntries([{ name: pinned, mode: "publish" }], entries, head, cwd), []);
});

for (const expectation of ["floor", "new", "absent"]) {
  test(`declared minimum uses exact immutable bytes: ${expectation}`, async t => {
    const f = fixture(t);
    const selected = f.pack(lib("1.2.0"), 'export const marker = "new";', "verify");
    const target = f.pack(consumer("2.0.0"), requireMarker(expectation), "publish");
    const floor = expectation !== "absent" && f.pack(lib("1.0.0"), 'export const marker = "floor";', "verify");
    const verify = () => f.verify([target, selected], { [library]: "1.2.0" });
    if (expectation === "absent") await assert.rejects(verify, /must already be published/);
    else if (expectation === "new") await assert.rejects(verify, /wrong immutable library bytes: floor/);
    else {
      const { checks } = await verify();
      assert.equal(checks.length, 1); assert.equal(checks[0].status, "installed");
      assert.equal(checks[0].artifacts.find(c => c.name === library).integrity, floor.file.integrity);
    }
  });
}
