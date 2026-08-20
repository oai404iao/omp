import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = mkdtempSync(join(tmpdir(), "pi-keep-defaults-fallback-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const settingsPath = join(agentDir, "settings.json");
const baseline = {
	defaultProvider: "openai",
	defaultModel: "fallback-baseline",
	defaultThinkingLevel: "high",
};
writeFileSync(settingsPath, JSON.stringify(baseline, null, 2));

const PATCHED = Symbol.for("pi-keep-defaults.settings-manager-patched");
const { SettingsManager } = await import("@earendil-works/pi-coding-agent");
let markerGetterCalls = 0;
Object.defineProperty(SettingsManager.prototype, PATCHED, {
	get() {
		markerGetterCalls += 1;
		throw new Error("injected marker getter failure");
	},
	configurable: true,
});

const { default: extension } = await import("../src/index.ts");
const handlers = new Map();
const notices = [];
const consoleWarnings = [];
const originalWarn = console.warn;
console.warn = (message) => consoleWarnings.push(String(message));
try {
	extension({
		on(event, handler) {
			handlers.set(event, handler);
		},
		registerCommand() {},
	});
	await handlers.get("session_start")?.(
		{ reason: "startup" },
		{ ui: { notify: (message, level) => notices.push({ message, level }) } },
	);

	writeFileSync(settingsPath, JSON.stringify({ ...baseline, defaultModel: "bypass-write" }, null, 2));
	const deadline = Date.now() + 750;
	while (JSON.parse(readFileSync(settingsPath, "utf8")).defaultModel !== baseline.defaultModel) {
		if (Date.now() >= deadline) throw new Error("file guard did not restore fallback write");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
} finally {
	await handlers.get("session_shutdown")?.({ reason: "quit" }, { ui: { notify: () => {} } });
	console.warn = originalWarn;
	rmSync(agentDir, { recursive: true, force: true });
}

assert.equal(markerGetterCalls, 0, "compatibility preflight must not invoke a marker accessor");
assert.ok(consoleWarnings.some((message) => message.includes("SettingsManager patch is unavailable")));
assert.ok(notices.some(({ message, level }) => level === "warning" && message.includes("file guard")));
console.log("PASS: throwing marker accessor falls back without preventing the file guard");
