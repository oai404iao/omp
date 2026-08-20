import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = mkdtempSync(join(tmpdir(), "pi-keep-defaults-guard-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { default: extension } = await import("../src/index.ts");
const settingsPath = join(agentDir, "settings.json");
const baseline = {
	defaultProvider: "openai",
	defaultModel: "deepseek-v4-flash",
	defaultThinkingLevel: "max",
};
writeFileSync(settingsPath, JSON.stringify(baseline, null, 2), "utf8");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitUntil = async (predicate, timeoutMs = 500) => {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("timed out waiting for guard state");
		await wait(5);
	}
};
const handlers = new Map();
let commandHandler;
const notices = [];
const pi = {
	on(event, handler) {
		handlers.set(event, handler);
	},
	registerCommand(_name, options) {
		commandHandler = options.handler;
	},
};
const ctx = {
	ui: {
		notify(message, level) {
			notices.push({ message, level });
		},
	},
};

// Model an in-process upgrade with more than one already queued v1 debounce.
// Replacing the global state must permanently disable their captured object.
const stateSymbol = Symbol.for("pi-keep-defaults.state");
let legacyWatcherClosed = false;
const legacyState = {
	enabled: true,
	settingsPath,
	desired: { defaultModel: "obsolete-v1-baseline" },
	ui: ctx.ui,
	watcher: { close: () => { legacyWatcherClosed = true; } },
};
globalThis[stateSymbol] = legacyState;
for (const delay of [30, 50]) {
	setTimeout(() => {
		if (!legacyState.enabled) return;
		writeFileSync(settingsPath, JSON.stringify({ ...baseline, defaultModel: legacyState.desired.defaultModel }, null, 2));
	}, delay);
}

extension(pi);
await handlers.get("session_start")?.({ reason: "startup" }, ctx);
await wait(80);
assert.equal(legacyState.enabled, false);
assert.equal(legacyWatcherClosed, true);
assert.equal(globalThis[stateSymbol].configured, true, "v1 enabled must migrate to the persistent preference");
assert.equal(globalThis[stateSymbol].enabled, true, "session_start must activate the migrated preference");
assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), baseline);
console.log("PASS: v1 watcher and multiple pending timers are neutralized during migration");

writeFileSync(
	settingsPath,
	JSON.stringify(
		{
			defaultProvider: "anthropic",
			defaultModel: "claude-sonnet-4-5",
			defaultThinkingLevel: "low",
		},
		null,
		2,
	),
	"utf8",
);
await wait(250);
assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), baseline);
console.log("PASS: session_start guard restores bypass writes");

writeFileSync(settingsPath, JSON.stringify({ ...baseline, theme: "light" }, null, 2), "utf8");
await wait(250);
assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).theme, "light");
console.log("PASS: file guard preserves unrelated settings");

// Valid JSON may still not be a settings object. The debounce callback must
// leave every such file byte-for-byte intact, then continue protecting a later
// valid settings object instead of crashing or coercing its shape.
for (const raw of ["null", JSON.stringify("not a settings object"), "[]"]) {
	writeFileSync(settingsPath, raw, "utf8");
	await wait(150);
	assert.equal(readFileSync(settingsPath, "utf8"), raw);
}
writeFileSync(settingsPath, JSON.stringify({ ...baseline, defaultModel: "restore-after-non-object" }, null, 2), "utf8");
await wait(250);
assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).defaultModel, baseline.defaultModel);
console.log("PASS: non-object JSON is ignored without crashing and later object writes remain guarded");

// Exercise the asynchronous FSWatcher error path directly. It must close the
// guard, cancel pending work, warn through console/UI, and never throw.
const sharedState = globalThis[stateSymbol];
const watcherBeforeError = sharedState.current.watcher;
const originalErrorWarn = console.warn;
const asyncErrorWarnings = [];
console.warn = (message) => asyncErrorWarnings.push(String(message));
try {
	watcherBeforeError.emit("error", new Error("injected watcher error"));
} finally {
	console.warn = originalErrorWarn;
}
assert.equal(sharedState.current.watcher, undefined);
assert.ok(asyncErrorWarnings.some((message) => message.includes("watcher error")));
assert.ok(notices.some(({ message, level }) => level === "warning" && message.includes("watcher error")));
await commandHandler("on", ctx);
console.log("PASS: asynchronous watcher errors are handled and warning-only");

await commandHandler("off", ctx);
assert.equal(sharedState.configured, false);
assert.equal(sharedState.enabled, false);
writeFileSync(settingsPath, JSON.stringify({ ...baseline, defaultModel: "off-change" }, null, 2), "utf8");
await wait(150);
assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).defaultModel, "off-change");

await commandHandler("on", ctx);
assert.equal(sharedState.configured, true);
assert.equal(sharedState.enabled, true);
writeFileSync(settingsPath, JSON.stringify({ ...baseline, defaultModel: "on-bypass" }, null, 2), "utf8");
await wait(250);
assert.equal(
	JSON.parse(readFileSync(settingsPath, "utf8")).defaultModel,
	"off-change",
	"on must recapture the current file before restarting the guard",
);
console.log("PASS: off stops the guard and on recaptures/restarts it");

// Give fs.watch time to enqueue the single 60ms debounce, then shut down before
// it fires. The changed file must remain changed and the process must exit
// naturally after the final assertion (no forced-exit workaround).
writeFileSync(settingsPath, JSON.stringify({ ...baseline, defaultModel: "pending-at-shutdown" }, null, 2), "utf8");
await waitUntil(() => sharedState.current.debounceTimer !== undefined);
const firstTimer = sharedState.current.debounceTimer;
assert.equal(firstTimer.hasRef(), false, "debounce timer must be unref'ed");
writeFileSync(settingsPath, JSON.stringify({ ...baseline, defaultModel: "pending-at-shutdown" }, null, 2), "utf8");
await waitUntil(() => sharedState.current.debounceTimer !== undefined && sharedState.current.debounceTimer !== firstTimer);
assert.equal(sharedState.current.debounceTimer.hasRef(), false);
await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
assert.equal(sharedState.enabled, false, "shutdown must deactivate wrappers");
assert.equal(sharedState.configured, true, "shutdown must retain the configured preference");
await wait(150);
assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).defaultModel, "pending-at-shutdown");
console.log("PASS: shutdown is idempotent and cancels pending debounce restoration");

rmSync(agentDir, { recursive: true, force: true });

// Starting a session against an unavailable agent directory must degrade
// without throwing and must surface both console and UI warnings.
const failedHandlers = new Map();
const failedNotices = [];
extension({
	on(event, handler) {
		failedHandlers.set(event, handler);
	},
	registerCommand() {},
});
const originalWarn = console.warn;
const consoleWarnings = [];
console.warn = (message) => consoleWarnings.push(String(message));
try {
	await failedHandlers.get("session_start")?.(
		{ reason: "startup" },
		{ ui: { notify: (message, level) => failedNotices.push({ message, level }) } },
	);
} finally {
	console.warn = originalWarn;
}
assert.ok(consoleWarnings.some((message) => message.includes("could not start the settings.json file guard")));
assert.ok(failedNotices.some(({ message, level }) => level === "warning" && message.includes("file guard")));
await failedHandlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
console.log("PASS: synchronous watch failure degrades with console/UI warnings");

console.log("\nAll guard tests passed; resources are closed for natural exit.");
