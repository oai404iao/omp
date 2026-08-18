/**
 * Smoke test for pi-keep-defaults.
 *
 * Loads the real extension with a stub pi API and verifies that
 * SettingsManager default setters are frozen while protection is on,
 * and delegate normally while protection is off.
 *
 * Run with: node --experimental-strip-types test/smoke.mjs
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";

const agentDir = mkdtempSync(join(tmpdir(), "pi-keep-defaults-smoke-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const handlers = new Map();
let commandHandler;

const pi = {
	on: (event, handler) => {
		handlers.set(event, handler);
	},
	registerCommand: (name, options) => {
		assert.equal(name, "keep-defaults");
		commandHandler = options.handler;
	},
};

const ctx = { ui: { notify: () => {} } };

extension(pi);

// Simulate a session so the ui handle is set.
handlers.get("session_start")?.({}, ctx);

const sm = SettingsManager.inMemory({
	defaultProvider: "openai",
	defaultModel: "deepseek-v4-flash",
	defaultThinkingLevel: "max",
});

// --- Protection ON (default): writes must be ignored ---
sm.setDefaultModelAndProvider("anthropic", "claude-sonnet-4-5");
sm.setDefaultThinkingLevel("low");
assert.equal(sm.getDefaultProvider(), "openai", "defaultProvider must stay frozen");
assert.equal(sm.getDefaultModel(), "deepseek-v4-flash", "defaultModel must stay frozen");
assert.equal(sm.getDefaultThinkingLevel(), "max", "defaultThinkingLevel must stay frozen");
console.log("PASS: protection ON freezes defaults (setDefaultModelAndProvider / setDefaultThinkingLevel)");

// --- Protection OFF: original behavior restored ---
await commandHandler("off", ctx);
sm.setDefaultModelAndProvider("anthropic", "claude-sonnet-4-5");
sm.setDefaultThinkingLevel("low");
assert.equal(sm.getDefaultProvider(), "anthropic");
assert.equal(sm.getDefaultModel(), "claude-sonnet-4-5");
assert.equal(sm.getDefaultThinkingLevel(), "low");
console.log("PASS: protection OFF restores original write behavior");

// --- Back ON: frozen again ---
await commandHandler("on", ctx);
sm.setDefaultModelAndProvider("xai", "grok-4.5");
sm.setDefaultThinkingLevel("medium");
assert.equal(sm.getDefaultModel(), "claude-sonnet-4-5", "defaultModel must stay frozen after re-enable");
assert.equal(sm.getDefaultThinkingLevel(), "low", "defaultThinkingLevel must stay frozen after re-enable");
console.log("PASS: protection re-enable freezes again");

// --- Idempotent patch install (simulates /reload) ---
extension(pi);
sm.setDefaultModelAndProvider("openai", "gpt-5.6-terra");
assert.equal(sm.getDefaultModel(), "claude-sonnet-4-5", "patch must stay installed across reload");
console.log("PASS: patch survives reload (idempotent)");

console.log("\nAll smoke tests passed.");

// The extension keeps an fs.watch open on the settings dir; exit explicitly.
rmSync(agentDir, { recursive: true, force: true });
process.exit(0);
