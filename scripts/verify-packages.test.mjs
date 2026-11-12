import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

function verify(files = {}, extraManifest = {}) {
  const scratch = join(process.env.HOME, ".local/state/agents/tmp");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "omp-pack-regression-"));
  const scripts = join(root, "scripts");
  mkdirSync(scripts);
  copyFileSync(new URL("./verify-packages.mjs", import.meta.url), join(scripts, "verify-packages.mjs"));
  writeFileSync(join(scripts, "workspaces.mjs"), `
    import { readFileSync } from "node:fs";
    import { resolve } from "node:path";
    export const root = ${JSON.stringify(root)};
    export const registry = "https://registry.npmjs.org/";
    export const workspaces = [{ name: "@fixture/extension", directory: "extension", releaseStatus: "publishable", kind: "extension" }];
    export const readManifest = directory => JSON.parse(readFileSync(resolve(root, directory, "package.json")));
  `);
  writeFileSync(join(scripts, "pi-baselines.mjs"), 'export const piFloor = "1.2.0"; export const piVersion = () => "1.4.0";');
  writeFileSync(join(scripts, "pnpm-lock.mjs"), 'export const readPnpmLock = () => ({ importers: { extension: {} } });');
  const manifest = {
    name: "@fixture/extension", version: "1.0.0", type: "module", license: "MIT",
    keywords: ["pi-package"], pi: { extensions: ["./index.ts"] },
    publishConfig: { access: "public", registry: "https://registry.npmjs.org/" },
    files: ["index.ts", "src/", "LICENSE"], ...extraManifest,
  };
  for (const [path, content] of Object.entries({
    "package.json": JSON.stringify(manifest), "index.ts": "export default () => {};",
    "src/helper.ts": "export const value = 1;", LICENSE: "MIT", "README.md": "# Fixture\n", ...files,
  })) {
    const target = join(root, "extension", path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  const result = spawnSync(process.execPath, [join(scripts, "verify-packages.mjs")], {
    cwd: root, encoding: "utf8", timeout: 60000,
    env: { ...process.env, npm_config_offline: "true", npm_config_audit: "false" },
  });
  assert.equal(result.error, undefined);
  return { status: result.status, output: result.stdout + result.stderr };
}

test("manifest-derived allowlist accepts a real archive including implicit README and package.json", () => {
  const result = verify();
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /5 files/);
});

test("an explicitly declared source file must exist before packing", () => {
  const result = verify({}, { files: ["index.ts", "src/", "src/missing.ts", "LICENSE"] });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /files entry matches nothing: src\/missing\.ts/);
});

test("a sensitive config nested under an allowed source directory is rejected", () => {
  const result = verify({ "src/config.json": '{"token":"fixture"}' });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /sensitive or local-only path would be published: src\/config\.json/);
});

test("test source nested under an allowed source directory is rejected", () => {
  const result = verify({ "src/worker.test.ts": "export {};" });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /development-only path would be published: src\/worker\.test\.ts/);
});

test("an implicit main entry cannot add an undeclared archive file", () => {
  const result = verify({ "extra.js": "export {};" }, { main: "extra.js" });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /tarball contains undeclared file extra\.js/);
});
