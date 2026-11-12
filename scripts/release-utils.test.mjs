import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { root } from "./workspaces.mjs";

function lookup(t, response, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "omp-release-utils-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const scripts = join(directory, "scripts"), bin = join(directory, "bin");
  for (const path of [scripts, bin, join(directory, "release-locks")]) mkdirSync(path);
  copyFileSync(join(root, "scripts/release-utils.mjs"), join(scripts, "release-utils.mjs"));
  writeFileSync(join(directory, "package.json"), JSON.stringify({ devDependencies: { npm: options.pin ?? "11.19.0" } }));
  writeFileSync(join(scripts, "workspaces.mjs"), `export const root = ${JSON.stringify(directory)};
export const registry = "https://registry.npmjs.org/";`);
  writeFileSync(join(directory, "release-locks/npm-published-artifacts.json"), JSON.stringify({
    schemaVersion: 1, registry: "https://registry.npmjs.org/", releases: {},
  }));
  const npmMock = version => `#!/usr/bin/env node
if (process.argv[2] === "--version") { console.log(${JSON.stringify(version)}); }
else { console.log(${JSON.stringify(JSON.stringify(response))}); process.exit(${options.status ?? 0}); }
`;
  writeFileSync(join(bin, "npm"), npmMock(options.clientVersion ?? "11.19.0"));
  chmodSync(join(bin, "npm"), 0o755);
  if (options.localClientVersion) {
    const localBin = join(directory, "node_modules/.bin");
    mkdirSync(localBin, { recursive: true });
    writeFileSync(join(localBin, "npm"), npmMock(options.localClientVersion));
    chmodSync(join(localBin, "npm"), 0o755);
  }
  const operation = options.operation ?? "lookupPublishedVersion";
  const code = operation === "planner" ? `
    const cp = await import("node:child_process");
    const spawnSync = cp.default.spawnSync;
    cp.default.spawnSync = (command, ...args) => {
      if (String(command).includes("npm")) throw new Error("planner must not invoke npm");
      return spawnSync(command, ...args);
    };
    (await import("node:module")).syncBuiltinESMExports();
    await import(${JSON.stringify(join(root, "scripts/ci/plan.mjs"))});
    console.log("loaded");
  ` : `
    import * as release from ${JSON.stringify(join(scripts, "release-utils.mjs"))};
    console.log(JSON.stringify(release[${JSON.stringify(operation)}]("@fixture/package", "1.0.0")));
  `;
  return spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
}

const metadata = { version: "1.0.0", gitHead: "source", "dist.integrity": "sha512-fixture" };
test("exact metadata accepts objects, singleton arrays and string versions", { skip: process.platform === "win32" }, t => {
  const nested = { version: "1.0.0", gitHead: "source", dist: { integrity: "sha512-fixture" } };
  for (const response of [metadata, [metadata], nested, [nested]]) {
    const child = lookup(t, response);
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), {
      exists: true, version: "1.0.0", gitHead: "source", integrity: "sha512-fixture",
    });
  }
  for (const response of ["1.0.0", ["1.0.0"]]) {
    const child = lookup(t, response);
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { exists: true, version: "1.0.0" });
  }
});

test("empty, multiple and mismatched metadata fail closed", { skip: process.platform === "win32" }, t => {
  for (const response of [[], [metadata, metadata], [{ ...metadata, version: "2.0.0" }], [[metadata]], null, {}]) {
    const child = lookup(t, response);
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /ambiguous version metadata|npm returned version/);
  }
});

test("npm client must match the exact repository pin", { skip: process.platform === "win32" }, t => {
  for (const options of [
    ...["lookupPublishedVersion", "lookupDistTags", "lookupPublishedVersions"]
      .map(operation => ({ operation, clientVersion: "12.0.0" })),
    { pin: "^11.19.0" },
  ]) {
    const child = lookup(t, metadata, options);
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /requires npm 11.19.0|requires an exact npm devDependency pin/);
  }
});

test("plain node can import the CI planner without a pinned npm client", { skip: process.platform === "win32" }, t => {
  const child = lookup(t, metadata, { operation: "planner", clientVersion: "12.0.0" });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), "loaded");
});

test("plain node registry lookups prefer the installed local npm over the host client", { skip: process.platform === "win32" }, t => {
  const child = lookup(t, metadata, { clientVersion: "12.0.0", localClientVersion: "11.19.0" });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).version, "1.0.0");
});
