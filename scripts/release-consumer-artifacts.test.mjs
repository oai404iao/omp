import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireArtifacts, boundedFetch, canonicalTarball, digest, validateManifest, verifyArchive } from "./release-consumer-artifacts.mjs";
import { verifyReleaseInstallations } from "./verify-release-installations.mjs";
import { registry } from "./workspaces.mjs";

const commit = "a".repeat(40);
const parent = join(homedir(), ".local/state/agents/tmp");
mkdirSync(parent, { recursive: true });
function fixture(t) {
  const directory = mkdtempSync(join(parent, "release-consumer-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifest = { name: "@oai404iao/fixture", version: "1.0.0", dependencies: {}, type: "module" };
  const candidate = { name: manifest.name, version: manifest.version, directory: "pi-extensions/fixture", mode: "publish",
    tag: `${manifest.name}@${manifest.version}`, prerelease: false, distTag: "latest", sourceCommit: commit, filename: "fixture.tgz" };
  mkdirSync(join(directory, "package"));
  writeFileSync(join(directory, "package/package.json"), JSON.stringify({ ...manifest, gitHead: commit }));
  const path = join(directory, candidate.filename);
  assert.equal(spawnSync("tar", ["-czf", path, "package/"], { cwd: directory }).status, 0);
  candidate.integrity = digest(readFileSync(path));
  const release = { schemaVersion: 2, commit, registry, requestedPackages: [manifest.name], candidates: [candidate] };
  const entries = [{ name: manifest.name, directory: candidate.directory, releaseStatus: "publishable" }];
  return { directory, manifest, candidate, path, release, entries };
}
const validation = f => ({ commit, entries: f.entries, manifestFor: () => f.manifest, env: { RELEASE_PACKAGE: f.manifest.name } });

test("validation isolates fixture environments but defaults to production SHA and selection guards", t => {
  const f = fixture(t);
  assert.doesNotThrow(() => validateManifest(f.release, validation(f)));
  assert.throws(() => validateManifest(f.release, { ...validation(f), env: { RELEASE_PACKAGE: f.manifest.name, GITHUB_SHA: "b".repeat(40) } }), /GITHUB_SHA/);
  assert.throws(() => validateManifest(f.release, { ...validation(f), env: { RELEASE_PACKAGE: "@oai404iao/pi-notify" } }), /Unapproved release target/);
  for (const env of [{ GITHUB_SHA: "b".repeat(40), RELEASE_PACKAGE: f.manifest.name },
    { GITHUB_SHA: commit, RELEASE_PACKAGE: "@oai404iao/pi-notify" }]) {
    const script = `import assert from "node:assert/strict";
import { validateManifest } from ${JSON.stringify(new URL("./release-consumer-artifacts.mjs", import.meta.url).href)};
assert.throws(() => validateManifest(${JSON.stringify(f.release)}, {
  commit: ${JSON.stringify(commit)}, entries: ${JSON.stringify(f.entries)}, manifestFor: () => (${JSON.stringify(f.manifest)})
}), ${env.GITHUB_SHA === commit ? "/Unapproved release target/" : "/GITHUB_SHA/"});`;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      encoding: "utf8", env: { ...process.env, ...env }, timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
});

test("canonical exact batch and targeted mode reject invalid closure, identity and selection", t => {
  const f = fixture(t);
  assert.equal(validateManifest(f.release, validation(f)).length, 1);
  for (const mutate of [r => r.candidates.push({ ...r.candidates[0] }), r => r.registry = "https://evil.invalid/",
    r => r.commit = "b".repeat(40), r => r.candidates[0].sourceCommit = "b".repeat(40),
    r => r.candidates[0].integrity = "sha512-bogus", r => r.candidates = []]) {
    const bad = structuredClone(f.release); mutate(bad);
    assert.throws(() => validateManifest(bad, validation(f)));
  }
  assert.throws(() => validateManifest({ ...f.release, requestedPackages: [] }, validation(f)));
  assert.throws(() => validateManifest(f.release, { ...validation(f), env: {} }));
});

test("packed historical manifest, gitHead, archive checksum and symlinks are checked", t => {
  const f = fixture(t);
  verifyArchive(f.candidate, f.path, f.manifest);
  assert.throws(() => verifyArchive(f.candidate, f.path, { ...f.manifest, dependencies: { wrong: "1" } }), /dependencies/);
  assert.throws(() => verifyArchive({ ...f.candidate, sourceCommit: "b".repeat(40) }, f.path, f.manifest), /identity/);
  const link = join(f.directory, "linked.tgz"); symlinkSync(f.path, link);
  assert.throws(() => verifyArchive(f.candidate, link, f.manifest), /regular file/);
  writeFileSync(f.path, "mutated");
  assert.throws(() => verifyArchive(f.candidate, f.path, f.manifest));
});

test("verify AND recover use exact integrity-verified registry bytes, never pack checkout", async t => {
  for (const mode of ["verify", "recover"]) {
    const f = fixture(t);
    f.candidate.mode = mode;
    delete f.candidate.filename;
    const metadata = { name: f.manifest.name, version: f.manifest.version, gitHead: commit,
      dist: { integrity: f.candidate.integrity, tarball: canonicalTarball(f.candidate) } };
    const calls = [];
    const transport = async url => {
      calls.push(url);
      return calls.length === 1 ? Response.json(metadata) : new Response(readFileSync(f.path));
    };
    const artifacts = await acquireArtifacts([f.candidate], new Map([[f.manifest.name, f.manifest]]),
      f.directory, "/checkout/must/not/be/packed", { transport, checkPublished: () => {}, commit });
    assert.equal(digest(readFileSync(artifacts.get(f.manifest.name).path)), f.candidate.integrity);
    assert.equal(calls.length, 2);
    assert.equal(calls[1], canonicalTarball(f.candidate));
  }
});

test("targeted selection requires the exact transitive closure and verify-only dependency modes", t => {
  const f = fixture(t);
  const dependency = { ...f.candidate, name: "@oai404iao/dependency", directory: "pi-extensions/dependency",
    tag: "@oai404iao/dependency@1.0.0", mode: "verify" };
  const manifests = new Map([[f.manifest.name, { ...f.manifest, dependencies: { [dependency.name]: "1.0.0" } }],
    [dependency.name, { name: dependency.name, version: "1.0.0" }]]);
  const entries = [...f.entries, { name: dependency.name, directory: dependency.directory, releaseStatus: "publishable" }];
  const release = { ...f.release, candidates: [f.candidate, dependency] };
  const options = { commit, entries, manifestFor: e => manifests.get(e.name), historicalManifest: e => manifests.get(e.name), requestedPackage: f.manifest.name, env: {} };
  assert.deepEqual(validateManifest(release, options).map(c => c.name), [dependency.name, f.manifest.name]);
  assert.throws(() => validateManifest({ ...release, candidates: [f.candidate] }, options), /closure/);
  assert.throws(() => validateManifest({ ...release, candidates: [f.candidate, { ...dependency, mode: "recover" }] }, options), /mode/);
});

test("wrong metadata identity, gitHead, integrity, URL and downloaded bytes fail closed", async t => {
  for (const mutate of [m => m.name = "other", m => m.version = "2.0.0", m => m.gitHead = "b".repeat(40),
    m => m.dist.integrity = "sha512-wrong", m => m.dist.tarball += "?token=bad",
    m => m.dist.tarball = "https://evil.invalid/a.tgz"]) {
    const f = fixture(t); f.candidate.mode = "recover";
    const metadata = { name: f.manifest.name, version: f.manifest.version, gitHead: commit,
      dist: { integrity: f.candidate.integrity, tarball: canonicalTarball(f.candidate) } }; mutate(metadata);
    await assert.rejects(acquireArtifacts([f.candidate], new Map([[f.manifest.name, f.manifest]]), f.directory, f.directory,
      { transport: async () => Response.json(metadata), checkPublished: () => {}, commit }), /mismatch/);
  }
  const f = fixture(t); f.candidate.mode = "verify";
  let calls = 0;
  await assert.rejects(acquireArtifacts([f.candidate], new Map([[f.manifest.name, f.manifest]]), f.directory, f.directory,
    { transport: async () => ++calls === 1 ? Response.json({ name: f.manifest.name, version: f.manifest.version, gitHead: commit,
      dist: { integrity: f.candidate.integrity, tarball: canonicalTarball(f.candidate) } }) : new Response("wrong"),
    checkPublished: () => {}, commit }), /archive integrity/);
});

test("transport rejects redirects, oversized responses, failed requests", async () => {
  for (const response of [new Response("no", { status: 302 }), new Response("too large"),
    new Response("", { headers: { "content-length": "100" } })]) {
    await assert.rejects(boundedFetch("https://registry.npmjs.org/fixture", 2, async () => response));
  }
  await assert.rejects(boundedFetch("https://registry.npmjs.org/fixture", 2, async (_url, options) => {
    assert.equal(options.redirect, "error"); assert.ok(options.signal); throw new Error("redirect rejected");
  }), /redirect/);
});

test("end-to-end orchestration binds receipt to tested bytes and detects post-check mutation", async t => {
  for (const mutate of [false, "artifact", "manifest"]) {
    const f = fixture(t);
    const path = join(f.directory, "manifest.json"); writeFileSync(path, JSON.stringify(f.release));
    const options = { validation: validation(f), historicalManifest: () => f.manifest, lock: {}, acquisition: { commit },
      install: (_c, manifests, artifacts) => {
        // A changed checkout payload is not used as a source artifact.
        assert.equal(manifests.get(f.manifest.name), f.manifest);
        assert.equal(artifacts.get(f.manifest.name).path, f.path);
        if (mutate === "artifact") writeFileSync(f.path, "changed after install");
        if (mutate === "manifest") writeFileSync(path, "{}");
        return [{ label: "fixture", requested: [f.manifest.name], included: [f.manifest.name] }];
      } };
    if (mutate) await assert.rejects(verifyReleaseInstallations(path, options));
    else {
      const receipt = await verifyReleaseInstallations(path, options);
      assert.equal(receipt.manifestIntegrity, digest(readFileSync(path)));
      assert.equal(receipt.artifacts[0].integrity, digest(readFileSync(f.path)));
      assert.deepEqual(JSON.parse(readFileSync(join(f.directory, "consumer-verification.json"))), receipt);
    }
  }
});
