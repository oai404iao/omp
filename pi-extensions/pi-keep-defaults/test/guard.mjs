/**
 * Smoke test for the file-guard backstop of pi-keep-defaults.
 *
 * Points getAgentDir() at a throwaway directory via PI_CODING_AGENT_DIR,
 * loads the real extension, then writes a protected field into the
 * settings file behind its back (simulating a write path that bypasses
 * SettingsManager). The guard must revert it.
 *
 * Run with: PI_CODING_AGENT_DIR=/tmp/... node --experimental-strip-types test/guard.mjs
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";

const envDir = process.env.PI_CODING_AGENT_DIR;
if (!envDir) {
	console.error("Set PI_CODING_AGENT_DIR to a throwaway directory before running this test.");
	process.exit(2);
}
const agentDir = envDir;
mkdirSync(agentDir, { recursive: true });

const settingsPath = join(agentDir, "settings.json");
writeFileSync(settingsPath, JSON.stringify({ defaultProvider: "openai", defaultModel: "deepseek-v4-flash", defaultThinkingLevel: "max" }, null, 2), "utf8");

assert.equal(getAgentDir(), agentDir, "env override must point at the throwaway dir");

const pi = {
	on: () => {},
	registerCommand: () => {},
};
extension(pi);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Simulate a write path that bypasses the SettingsManager patch.
writeFileSync(settingsPath, JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-sonnet-4-5", defaultThinkingLevel: "low" }, null, 2), "utf8");

// The guard fires on fs.watch; give it time to revert.
await wait(500);
const after = JSON.parse(readFileSync(settingsPath, "utf8"));
assert.equal(after.defaultProvider, "openai", "guard must restore defaultProvider");
assert.equal(after.defaultModel, "deepseek-v4-flash", "guard must restore defaultModel");
assert.equal(after.defaultThinkingLevel, "max", "guard must restore defaultThinkingLevel");
console.log("PASS: file guard reverted the bypass write");

// A non-protected setting change must be left alone.
writeFileSync(settingsPath, JSON.stringify({ ...after, theme: "light" }, null, 2), "utf8");
await wait(500);
const afterTheme = JSON.parse(readFileSync(settingsPath, "utf8"));
assert.equal(afterTheme.theme, "light", "unrelated settings must be preserved");
assert.equal(afterTheme.defaultModel, "deepseek-v4-flash");
console.log("PASS: unrelated settings untouched");

rmSync(envDir, { recursive: true, force: true });
console.log("\nAll guard tests passed.");
process.exit(0);
