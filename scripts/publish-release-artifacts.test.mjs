import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const commit = "0123456789012345678901234567890123456789";

function candidate(name) {
  return {
    name,
    version: "1.0.0",
    directory: name.replaceAll("/", "-"),
    tag: `${name}@1.0.0`,
    mode: "recover",
    integrity: "sha512-fixture",
    sourceCommit: commit,
    distTag: "latest",
    prerelease: false,
    notes: "Example release",
  };
}

function runPublisher(candidates, wrongDistTagFor, options = {}) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "omp-publish-result-"));
  try {
    const binaryDirectory = join(temporaryDirectory, "bin");
    const manifestPath = join(temporaryDirectory, "manifest.json");
    const resultPath = join(temporaryDirectory, "result.json");
    const callLog = join(temporaryDirectory, "calls.log");
    mkdirSync(binaryDirectory);
    const scripts = join(temporaryDirectory, "scripts");
    mkdirSync(scripts);
    for (const name of ["publish-release-artifacts.mjs", "release-batch.mjs", "release-dependencies.mjs", "release-utils.mjs", "initial-codex-bootstrap.mjs"]) {
      writeFileSync(join(scripts, name), readFileSync(join(root, "scripts", name)));
    }
    mkdirSync(join(temporaryDirectory, "release-locks"));
    writeFileSync(join(temporaryDirectory, "release-locks/npm-published-artifacts.json"),
      JSON.stringify({ schemaVersion: 1, registry: "https://registry.npmjs.org/", releases: options.locked ?? {} }));
    const entries = candidates.map(c => ({ name: c.name, directory: c.directory, releaseStatus: "publishable" }));
    const manifests = {};
    const registryPackages = {};
    for (const c of candidates) {
      const manifest = { name: c.name, version: c.version, dependencies: options.dependencies?.[c.name] };
      if (options.privateFor === c.name) manifest.private = true;
      manifests[c.directory] = manifest;
      if (c.mode === "publish") {
        const stage = join(temporaryDirectory, "stage", c.directory);
        mkdirSync(join(stage, "package"), { recursive: true });
        writeFileSync(join(stage, "package/package.json"), JSON.stringify({ ...manifest, gitHead: commit }));
        c.filename = `${c.name.split("/").at(-1)}.tgz`;
        const tar = join(temporaryDirectory, c.filename);
        assert.equal(spawnSync("tar", ["-czf", tar, "-C", stage, "package"]).status, 0);
        c.integrity = `sha512-${createHash("sha512").update(readFileSync(tar)).digest("base64")}`;
      }
      registryPackages[`${c.name}@${c.version}`] = {
        version: c.version, gitHead: c.sourceCommit,
        "dist.integrity": options.wrongIntegrityFor === c.name ? "sha512-wrong" : c.integrity,
      };
      if (options.corruptFor === c.name) c.integrity = "sha512-invalid";
    }
    writeFileSync(join(scripts, "workspaces.mjs"), `
      export const root = ${JSON.stringify(temporaryDirectory)};
      export const registry = "https://registry.npmjs.org/";
      export const workspaces = ${JSON.stringify(entries)};
      const manifests = ${JSON.stringify(manifests)};
      export const readManifest = directory => manifests[directory];
    `);
    writeFileSync(
      join(binaryDirectory, "git"),
      [
        "#!/bin/sh",
        "printf 'git %s\\n' \"$*\" >> \"$CALL_LOG\"",
        "if [ \"$1\" = \"rev-parse\" ]; then echo \"$FAKE_COMMIT\"; exit 0; fi",
        "if [ \"$1\" = \"rev-list\" ]; then exit 1; fi",
        "exit 0",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(binaryDirectory, "npm"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, "npm " + args.join(" ") + "\\n");
if (args[0] === "publish") process.exit(args[1] === process.env.FAIL_PUBLISH_PATH ? 1 : 0);
if (args[0] !== "view") process.exit(1);
if (args[2] === "version") {
  console.log(JSON.stringify(JSON.parse(process.env.FAKE_PACKAGES)[args[1]]));
} else if (args[2] === "dist-tags") {
  console.log(JSON.stringify(JSON.parse(process.env.FAKE_DIST_TAGS)[args[1]]
    ?? { latest: args[1] === process.env.WRONG_DIST_TAG_FOR ? "0.9.0" : "1.0.0" }));
} else if (args[2] === "versions") {
  const value = JSON.parse(process.env.FAKE_VERSIONS)[args[1]];
  if (value === "lookup-error") process.exit(1);
  console.log(JSON.stringify(value ?? []));
} else process.exit(1);
`,
    );
    chmodSync(join(binaryDirectory, "git"), 0o755);
    chmodSync(join(binaryDirectory, "npm"), 0o755);
    writeFileSync(
      manifestPath,
      `${JSON.stringify({
        schemaVersion: 1,
        commit,
        registry: "https://registry.npmjs.org/",
        candidates,
      })}\n`,
    );

    const child = spawnSync(process.execPath, [join(scripts, "publish-release-artifacts.mjs"), manifestPath, resultPath], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binaryDirectory}:${process.env.PATH}`,
        CALL_LOG: callLog,
        FAKE_COMMIT: commit,
        GITHUB_SHA: commit,
        WRONG_DIST_TAG_FOR: wrongDistTagFor ?? "",
        FAKE_PACKAGES: JSON.stringify(registryPackages),
        FAKE_DIST_TAGS: JSON.stringify(options.distTags ?? {}),
        FAKE_VERSIONS: JSON.stringify(options.versions ?? {}),
        FAIL_PUBLISH_PATH: options.failPublishFor
          ? join(temporaryDirectory, `${options.failPublishFor.split("/").at(-1)}.tgz`) : "",
      },
    });
    return {
      process: child,
      result: existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")) : undefined,
      calls: readFileSync(callLog, "utf8"),
    };
  } finally {
    // The caller receives all data it needs before this task-owned directory is removed.
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function bootstrapCandidate(name = "@oai404iao/pi-codex-runtime") {
  const version = "0.1.0-alpha.1";
  return { ...candidate(name), version, tag: `${name}@${version}`, distTag: "next", prerelease: true,
    sourceCommit: "32ba01f3c08b7fd63d09e9b2373cf081c4525533" };
}

function bootstrapOptions(value) {
  return {
    locked: { [`${value.name}@${value.version}`]: { gitHead: value.sourceCommit, integrity: value.integrity } },
    distTags: { [value.name]: { next: value.version, latest: value.version } },
    versions: { [value.name]: [value.version] },
  };
}

test("reviewed initial bootstrap recovery accepts the registry-required latest alias without modifying tags", () => {
  const runtime = bootstrapCandidate();
  const bundle = { ...candidate("@oai404iao/consumer"), mode: "publish" };
  const { process, result, calls } = runPublisher([bundle, runtime], undefined, {
    ...bootstrapOptions(runtime), dependencies: { [bundle.name]: { [runtime.name]: runtime.version } },
  });
  assert.equal(process.status, 0, process.stderr);
  assert.equal(result.ok, true);
  assert.doesNotMatch(calls, /^npm publish .*pi-codex-runtime\.tgz/m);
  assert.doesNotMatch(calls, /^npm dist-tag/m);
  assert.ok(calls.indexOf(`npm view ${runtime.name} versions`) < calls.indexOf("npm publish "));
});

for (const failure of ["stable-history", "missing-lock", "wrong-lock", "wrong-source", "later-alpha", "wrong-next", "malformed-history", "lookup-error", "unapproved-package", "existing-bundle"]) {
  test(`bootstrap latest alias rejects ${failure} before publishing consumers`, () => {
    const runtime = bootstrapCandidate(failure === "unapproved-package" ? "@oai404iao/other-package" : undefined);
    if (failure === "existing-bundle") {
      runtime.name = "@oai404iao/pi-codex-minimal-tools";
      runtime.version = "1.4.1-alpha.0";
      runtime.tag = `${runtime.name}@${runtime.version}`;
    }
    if (failure === "wrong-source") runtime.sourceCommit = commit;
    if (failure === "later-alpha") {
      runtime.version = "0.1.0-alpha.2";
      runtime.tag = `${runtime.name}@${runtime.version}`;
    }
    const options = bootstrapOptions(runtime);
    if (failure === "stable-history") options.versions[runtime.name].unshift("0.0.1");
    if (failure === "missing-lock") options.locked = {};
    if (failure === "wrong-lock") options.locked[`${runtime.name}@${runtime.version}`].integrity = "sha512-wrong";
    if (failure === "wrong-next") options.distTags[runtime.name].next = "0.1.0-alpha.0";
    if (failure === "malformed-history") options.versions[runtime.name] = { bad: true };
    if (failure === "lookup-error") options.versions[runtime.name] = "lookup-error";
    if (failure === "existing-bundle") options.versions[runtime.name].unshift("1.4.0");
    const bundle = { ...candidate("@oai404iao/consumer"), mode: "publish" };
    const { process, result, calls } = runPublisher([runtime, bundle], undefined, {
      ...options, dependencies: { [bundle.name]: { [runtime.name]: runtime.version } },
    });
    if (failure === "wrong-lock") assert.notEqual(process.status, 0);
    else {
      assert.equal(process.status, 0, process.stderr);
      assert.equal(result.ok, false);
    }
    assert.doesNotMatch(calls, /^npm publish /m);
    assert.doesNotMatch(calls, /^git tag /m);
  });
}

test("partial reconciliation does not create local tags", { skip: process.platform === "win32" }, () => {
  const first = "@oai404iao/first";
  const second = "@oai404iao/second";
  const { process, result, calls } = runPublisher([candidate(first), candidate(second)], second);

  assert.equal(process.status, 0, process.stderr);
  assert.equal(result.ok, false);
  assert.equal(result.releases.length, 1);
  assert.deepEqual(result.unresolved, [
    `${second}@1.0.0 is not assigned to npm dist-tag latest; fix it interactively`,
  ]);
  assert.doesNotMatch(calls, /^git tag /m);
});

test("clean recovery creates missing tags only after all candidates reconcile", { skip: process.platform === "win32" }, () => {
  const first = "@oai404iao/first";
  const { process, result, calls } = runPublisher([candidate(first)]);

  assert.equal(process.status, 0, process.stderr);
  assert.equal(result.ok, true);
  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(result.publishWarnings, []);
  assert.match(calls, new RegExp(`^git tag ${first.replace("/", "\\/")}@1\\.0\\.0 ${commit}$`, "m"));
});

test("publisher reorders a shuffled batch and verifies dependency visibility before publishing dependents", () => {
  const runtime = "@oai404iao/runtime", bundle = "@oai404iao/bundle";
  const values = [bundle, runtime].map(name => ({ ...candidate(name), mode: "publish" }));
  const { process, result, calls } = runPublisher(values, undefined, {
    dependencies: { [bundle]: { [runtime]: "1.0.0" } },
  });
  assert.equal(process.status, 0, process.stderr);
  assert.equal(result.ok, true);
  const publish = calls.split("\n").filter(line => line.startsWith("npm publish "));
  assert.match(publish[0], /runtime\.tgz/);
  assert.match(publish[1], /bundle\.tgz/);
  assert.ok(calls.indexOf(`npm view ${runtime}@1.0.0`) < calls.indexOf(publish[1]));
});

for (const failure of ["failPublishFor", "wrongIntegrityFor"]) {
  test(`${failure} stops downstream publishing and all tag creation`, () => {
    const runtime = "@oai404iao/runtime", bundle = "@oai404iao/bundle";
    const values = [bundle, runtime].map(name => ({ ...candidate(name), mode: "publish" }));
    const { process, result, calls } = runPublisher(values, undefined, {
      dependencies: { [bundle]: { [runtime]: "1.0.0" } }, [failure]: runtime,
    });
    assert.equal(process.status, 0, process.stderr);
    assert.equal(result.ok, false);
    assert.doesNotMatch(calls, /^npm publish .*bundle\.tgz/m);
    assert.doesNotMatch(calls, /^git tag /m);
  });
}

for (const failure of ["corruptFor", "privateFor"]) {
  test(`${failure} fails the entire batch before any registry operation`, () => {
    const first = "@oai404iao/first", second = "@oai404iao/second";
    const values = [first, second].map(name => ({ ...candidate(name), mode: "publish" }));
    const { process, calls } = runPublisher(values, undefined, { [failure]: second });
    assert.notEqual(process.status, 0);
    assert.doesNotMatch(calls, /^npm /m);
    assert.doesNotMatch(calls, /^git tag /m);
  });
}

for (const mismatched of [false, true]) {
  test(`recovered dependencies ${mismatched ? "block consumers on integrity mismatch" : "allow consumers without republishing"}`, () => {
    const runtime = "@oai404iao/runtime", bundle = "@oai404iao/bundle";
    const values = [{ ...candidate(bundle), mode: "publish" }, candidate(runtime)];
    const { process, result, calls } = runPublisher(values, undefined, {
      dependencies: { [bundle]: { [runtime]: "1.0.0" } },
      wrongIntegrityFor: mismatched ? runtime : undefined,
    });
    assert.equal(process.status, 0, process.stderr);
    assert.equal(result.ok, !mismatched);
    assert.doesNotMatch(calls, /^npm publish .*runtime\.tgz/m);
    if (mismatched) {
      assert.doesNotMatch(calls, /^npm publish /m);
      assert.doesNotMatch(calls, /^git tag /m);
    } else assert.match(calls, /^npm publish .*bundle\.tgz/m);
  });
}
