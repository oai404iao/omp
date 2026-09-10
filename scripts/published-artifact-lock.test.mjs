import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { root } from "./workspaces.mjs";
import {
  assertLockedPublishedArtifact,
  lockedPublishedArtifact,
} from "./release-utils.mjs";

const publishedArtifacts = [
  {
    name: "@oai404iao/pi-codex-minimal-tools",
    version: "1.3.0",
    gitHead: "596d799c6f7db3508b6d46bb05cdca6ea9e3b716",
    integrity: "sha512-eEUta4JsIJldxM5w+0mAz28YUlev5IECN1kOGQrCX1rFm/xsOqHmdqArmIF94zZz8pbetFo+FPI9bohdwONvLg==",
  },
  {
    name: "@oai404iao/pi-external-thinking",
    version: "0.1.0",
    gitHead: "aae803f4b25603991d9375c602cf35da1df922b0",
    integrity: "sha512-9QsApxqkCZt3RqhuD0OEjurlPoEUJXO+ShZvn9baJ83GVyb2y8uSaenDU+fj5m+FHZ/NQ1NGnr6NMyIslDlDdA==",
  },
  {
    name: "@oai404iao/pi-keep-defaults",
    version: "0.1.3",
    gitHead: "16dccb8953b717670c34fe978c79c07d592ca7e2",
    integrity: "sha512-FrsUOeNfCEGzvyYsKk7vymPIDF79rCPQBZGJYlZQSa9TNDr4Tyn64177fujCwdJ9WltJ0XBw5XJWP9D0poBl+A==",
  },
  {
    name: "@oai404iao/pi-subagent",
    version: "0.2.0",
    gitHead: "ef42984c0e40ef1f26ead4b4c7d149b21280e66b",
    integrity: "sha512-gh7OJCdc8fejhP8eGXulb2kLG+/2t1rC8sOq8Ha5LwjzCPW9m+Jg0kJYmmZxqMT9DJDEsXWy8zl0mFy3NVbcGw==",
  },
  {
    name: "@oai404iao/pi-telegram-notify",
    version: "0.1.3",
    gitHead: "16dccb8953b717670c34fe978c79c07d592ca7e2",
    integrity: "sha512-FoCgTMMq5WDT8SIYhp64keiqa2u7eWaxoMM2D4AJWLvWcFDruvPYmHjIuNRE6zBLreorF6v2pHaJttor8bM4GA==",
  },
  ...[
    ["runtime", "sha512-i06b9iB8rw4IdcBT1ORW/OSyurnFTdH7bF5jcA7vrvAUiQW4mvu2Ah7FHZ90BMaVTCkmuotY2Q7Wcuo8lpKPkQ=="],
    ["core", "sha512-ckupSb20mdhglNAkB1VNHLaOHxFisZlkLx0cFsJn9ZashH/LCyttIE3g54zzm1eA7/3DxVluzCXfxLbDoQ0oLg=="],
    ["imagegen", "sha512-FG8NsrD/VAJNWN+buigEh6qguk8nhWf6BFZTX8BV3mFuNir6qnYtxeXRAt08T6r0UftKYHbCQXb76vgcvVbwLQ=="],
    ["web-search", "sha512-sIZdn8Q3Yxo7gQqxplFp8V3vdow6koONWt2vqPocRSJRObRGlSc+Fk/b+aBVAYUIsSHsZgHYfiMaYnuw0mDO/Q=="],
  ].map(([short, integrity]) => ({
    name: `@oai404iao/pi-codex-${short}`, version: "0.1.0-alpha.1",
    gitHead: "32ba01f3c08b7fd63d09e9b2373cf081c4525533", integrity,
  })),
];

test("published artifact lock pins every current manual bootstrap tarball", () => {
  for (const { name, version, gitHead, integrity } of publishedArtifacts) {
    const locked = lockedPublishedArtifact(name, version);
    assert.deepEqual(locked, { gitHead, integrity });
    assert.doesNotThrow(() => assertLockedPublishedArtifact(name, version, locked));
  }
});

test("published artifact lock rejects a mismatched registry integrity", () => {
  for (const { name, version } of publishedArtifacts) {
    const locked = lockedPublishedArtifact(name, version);
    assert.throws(
      () => assertLockedPublishedArtifact(name, version, { ...locked, integrity: "sha512-not-the-reviewed-artifact" }),
      /npm integrity .* does not match locked/,
    );
  }
});

test("published artifact lock rejects a mismatched registry source", () => {
  for (const { name, version } of publishedArtifacts) {
    assert.throws(
      () => assertLockedPublishedArtifact(name, version, { ...lockedPublishedArtifact(name, version), gitHead: "0".repeat(40) }),
      /npm gitHead .* does not match locked/,
    );
  }
});

test("preparation never repacks a locked published version after an E404 lookup", { skip: process.platform === "win32" }, () => {
  const temporary = mkdtempSync(join(tmpdir(), "omp-locked-visibility-"));
  try {
    const scripts = join(temporary, "scripts"), bin = join(temporary, "bin");
    mkdirSync(scripts); mkdirSync(bin); mkdirSync(join(temporary, "release-locks"));
    for (const file of ["prepare-release-artifacts.mjs", "release-utils.mjs", "release-dependencies.mjs", "recovery-guard.mjs"]) {
      copyFileSync(join(root, "scripts", file), join(scripts, file));
    }
    const value = publishedArtifacts.find(p => p.name === "@oai404iao/pi-codex-runtime");
    writeFileSync(join(temporary, "release-locks/npm-published-artifacts.json"), JSON.stringify({
      schemaVersion: 1, registry: "https://registry.npmjs.org/",
      releases: { [`${value.name}@${value.version}`]: { gitHead: value.gitHead, integrity: value.integrity } },
    }));
    writeFileSync(join(scripts, "workspaces.mjs"), `
      export const root = ${JSON.stringify(temporary)};
      export const registry = "https://registry.npmjs.org/";
      export const workspaces = [{name: ${JSON.stringify(value.name)}, directory: "runtime", releaseStatus: "publishable"}];
      export const artifactWorkspaces = () => workspaces;
      export const readManifest = () => (${JSON.stringify({ name: value.name, version: value.version, private: false })});
    `);
    const callLog = join(temporary, "calls.log");
    writeFileSync(join(bin, "git"), `#!/bin/sh
printf 'git %s\\n' "$*" >> "$CALL_LOG"
if [ "$1" = "rev-parse" ]; then echo "${value.gitHead}"; exit 0; fi
if [ "$1" = "status" ]; then exit 0; fi
exit 1
`);
    writeFileSync(join(bin, "npm"), `#!/bin/sh
printf 'npm %s\\n' "$*" >> "$CALL_LOG"
printf '{"error":{"code":"E404"}}\\n'
exit 1
`);
    for (const file of ["git", "npm"]) chmodSync(join(bin, file), 0o755);
    const child = spawnSync(process.execPath, [join(scripts, "prepare-release-artifacts.mjs")], {
      encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALL_LOG: callLog },
    });
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /locked as published.*registry verification is pending/i);
    const calls = readFileSync(callLog, "utf8");
    assert.doesNotMatch(calls, /git archive|npm pack|npm publish|git tag /);
    assert.equal(calls.split("\n").filter(line => line.startsWith("npm view ")).length, 1);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
