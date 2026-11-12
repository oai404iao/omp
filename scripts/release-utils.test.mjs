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
  writeFileSync(join(bin, "npm"), `#!/usr/bin/env node
if (process.argv[2] === "--version") { console.log(${JSON.stringify(options.clientVersion ?? "11.19.0")}); }
else { console.log(${JSON.stringify(JSON.stringify(response))}); process.exit(${options.status ?? 0}); }
`);
  chmodSync(join(bin, "npm"), 0o755);
  return spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { lookupPublishedVersion } from ${JSON.stringify(join(scripts, "release-utils.mjs"))};
    console.log(JSON.stringify(lookupPublishedVersion("@fixture/package", "1.0.0")));
  `], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
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
  for (const options of [{ clientVersion: "12.0.0" }, { pin: "^11.19.0" }]) {
    const child = lookup(t, metadata, options);
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /requires npm 11.19.0|requires an exact npm devDependency pin/);
  }
});
