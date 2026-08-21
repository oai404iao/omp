import assert from "node:assert/strict";
import test from "node:test";
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
];
const codex = publishedArtifacts[0];

test("published artifact lock pins every current manual bootstrap tarball", () => {
  for (const { name, version, gitHead, integrity } of publishedArtifacts) {
    const locked = lockedPublishedArtifact(name, version);
    assert.deepEqual(locked, { gitHead, integrity });
    assert.doesNotThrow(() => assertLockedPublishedArtifact(name, version, locked));
  }
});

test("published artifact lock rejects a mismatched registry integrity", () => {
  const locked = lockedPublishedArtifact(codex.name, codex.version);
  assert.throws(
    () => assertLockedPublishedArtifact(codex.name, codex.version, {
      ...locked,
      integrity: "sha512-not-the-reviewed-artifact",
    }),
    /npm integrity .* does not match locked/,
  );
});
