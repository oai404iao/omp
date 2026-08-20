import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = mkdtempSync(join(tmpdir(), "pi-keep-defaults-smoke-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { SettingsManager } = await import("@earendil-works/pi-coding-agent");
const { default: extension } = await import("../src/index.ts");
const settingsPath = join(agentDir, "settings.json");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitUntil = async (predicate, timeoutMs = 500) => {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("timed out waiting for guard state");
		await wait(5);
	}
};

function writeSettings(defaultModel) {
	writeFileSync(
		settingsPath,
		JSON.stringify(
			{
				defaultProvider: "openai",
				defaultModel,
				defaultThinkingLevel: "max",
			},
			null,
			2,
		),
		"utf8",
	);
}

function createRuntime() {
	const handlers = new Map();
	let commandHandler;
	const pi = {
		on(event, handler) {
			handlers.set(event, handler);
		},
		registerCommand(name, options) {
			assert.equal(name, "keep-defaults");
			commandHandler = options.handler;
		},
	};
	return { pi, handlers, get commandHandler() { return commandHandler; } };
}

const ctx = { ui: { notify: () => {} } };
writeSettings("baseline");

// A factory-only invocation may patch the process and register hooks, but must
// not start an fs watcher or debounce timer.
const first = createRuntime();
extension(first.pi);
writeSettings("factory-only-change");
await wait(150);
assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).defaultModel, "factory-only-change");
console.log("PASS: factory-only load starts no file guard");

await first.handlers.get("session_start")?.({ reason: "startup" }, ctx);

const sm = SettingsManager.inMemory({
	defaultProvider: "openai",
	defaultModel: "deepseek-v4-flash",
	defaultThinkingLevel: "max",
});

sm.setDefaultModelAndProvider("anthropic", "claude-sonnet-4-5");
sm.setDefaultThinkingLevel("low");
assert.equal(sm.getDefaultProvider(), "openai");
assert.equal(sm.getDefaultModel(), "deepseek-v4-flash");
assert.equal(sm.getDefaultThinkingLevel(), "max");
console.log("PASS: protection ON freezes SettingsManager defaults");

await first.commandHandler("off", ctx);
sm.setDefaultModelAndProvider("anthropic", "claude-sonnet-4-5");
sm.setDefaultThinkingLevel("low");
assert.equal(sm.getDefaultProvider(), "anthropic");
assert.equal(sm.getDefaultModel(), "claude-sonnet-4-5");
assert.equal(sm.getDefaultThinkingLevel(), "low");

await first.commandHandler("on", ctx);
sm.setDefaultModel("gpt-5.6");
assert.equal(sm.getDefaultModel(), "claude-sonnet-4-5");
console.log("PASS: off delegates and on freezes again");

const wrapperBeforeReload = Object.getOwnPropertyDescriptor(
	SettingsManager.prototype,
	"setDefaultModelAndProvider",
).value;
const second = createRuntime();
extension(second.pi);
const wrapperAfterReload = Object.getOwnPropertyDescriptor(
	SettingsManager.prototype,
	"setDefaultModelAndProvider",
).value;
assert.equal(wrapperAfterReload, wrapperBeforeReload, "reload must reuse the verified global wrapper");

// Let the second factory take ownership before the first shuts down. The stale
// timer must not restore its old baseline, and the stale shutdown must not
// close the replacement guard.
writeSettings("reload-baseline");
const sharedState = globalThis[Symbol.for("pi-keep-defaults.state")];
await waitUntil(() => sharedState.current.debounceTimer !== undefined);
await second.handlers.get("session_start")?.({ reason: "reload" }, ctx);
await first.handlers.get("session_shutdown")?.({ reason: "reload" }, ctx);
sm.setDefaultModel("must-remain-blocked-after-old-shutdown");
assert.equal(
	sm.getDefaultModel(),
	"claude-sonnet-4-5",
	"an old owner's shutdown must not deactivate the replacement session's wrappers",
);
await wait(100);
assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).defaultModel, "reload-baseline");
writeSettings("bypass-after-reload");
await wait(250);
assert.equal(
	JSON.parse(readFileSync(settingsPath, "utf8")).defaultModel,
	"reload-baseline",
	"new guard must survive the old factory's shutdown",
);
console.log("PASS: reload is idempotent and old timer/shutdown cannot affect the new guard");

await second.handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
await second.handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
assert.equal(sharedState.enabled, false, "the final owner shutdown must deactivate process-global protection");
assert.equal(sharedState.configured, true, "shutdown must preserve the user's ON preference");
sm.setDefaultModel("delegated-after-shutdown");
assert.equal(
	sm.getDefaultModel(),
	"delegated-after-shutdown",
	"installed wrappers must delegate to native setters when no session is active",
);
console.log("PASS: final shutdown restores native setter delegation without losing preference");

const third = createRuntime();
extension(third.pi);
sm.setDefaultModel("delegated-before-next-start");
assert.equal(sm.getDefaultModel(), "delegated-before-next-start", "factory load alone must not reactivate protection");
await third.handlers.get("session_start")?.({ reason: "next-session" }, ctx);
assert.equal(sharedState.enabled, true, "a new session must reactivate the configured ON preference");
sm.setDefaultModel("blocked-after-next-start");
assert.equal(sm.getDefaultModel(), "delegated-before-next-start");
await third.handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
assert.equal(sharedState.enabled, false);
console.log("PASS: a later session reactivates protection and its shutdown deactivates it");

rmSync(agentDir, { recursive: true, force: true });
console.log("\nAll smoke tests passed.");
