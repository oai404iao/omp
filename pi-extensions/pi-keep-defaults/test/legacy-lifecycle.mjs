import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = mkdtempSync(join(tmpdir(), "pi-keep-defaults-legacy-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
writeFileSync(
	join(agentDir, "settings.json"),
	JSON.stringify(
		{
			defaultProvider: "openai",
			defaultModel: "legacy-baseline",
			defaultThinkingLevel: "high",
		},
		null,
		2,
	),
);

const STATE = Symbol.for("pi-keep-defaults.state");
const PATCHED = Symbol.for("pi-keep-defaults.settings-manager-patched");
const SETTERS = [
	"setDefaultModelAndProvider",
	"setDefaultProvider",
	"setDefaultModel",
	"setDefaultThinkingLevel",
];
const { SettingsManager } = await import("@earendil-works/pi-coding-agent");

// Recreate the process-global v1 patch before loading the v2 extension. Its
// wrappers read global state.enabled on every invocation.
function getState() {
	return globalThis[STATE];
}
for (const name of SETTERS) {
	const descriptor = Object.getOwnPropertyDescriptor(SettingsManager.prototype, name);
	const original = descriptor.value;
	const wrapper = function patchedDefaultSetter(...args) {
		const state = getState();
		if (state.enabled) return undefined;
		return Reflect.apply(original, this, args);
	};
	Object.defineProperty(SettingsManager.prototype, name, { ...descriptor, value: wrapper });
}
SettingsManager.prototype[PATCHED] = 1;

let legacyWatcherClosed = false;
const legacyState = {
	enabled: false,
	watcher: { close: () => { legacyWatcherClosed = true; } },
};
globalThis[STATE] = legacyState;

const { default: extension } = await import("../src/index.ts");

function createRuntime() {
	const handlers = new Map();
	let commandHandler;
	return {
		pi: {
			on(event, handler) {
				handlers.set(event, handler);
			},
			registerCommand(_name, options) {
				commandHandler = options.handler;
			},
		},
		handlers,
		get commandHandler() {
			return commandHandler;
		},
	};
}

const ctx = { ui: { notify: () => {} } };
const first = createRuntime();
extension(first.pi);
await first.handlers.get("session_start")?.({ reason: "startup" }, ctx);

const state = globalThis[STATE];
assert.notEqual(state, legacyState);
assert.equal(legacyState.enabled, false, "the captured v1 state must remain permanently inactive");
assert.equal(legacyWatcherClosed, true);
assert.equal(state.configured, false, "the legacy OFF preference must survive migration");
assert.equal(state.enabled, false, "session_start must apply the migrated OFF preference");

const sm = SettingsManager.inMemory({
	defaultProvider: "openai",
	defaultModel: "before-on",
	defaultThinkingLevel: "high",
});
sm.setDefaultModel("delegated-while-off");
assert.equal(sm.getDefaultModel(), "delegated-while-off", "the retained v1 wrapper must read migrated active state");

await first.commandHandler("on", ctx);
assert.equal(state.configured, true);
assert.equal(state.enabled, true);
sm.setDefaultModel("blocked-after-on");
assert.equal(sm.getDefaultModel(), "delegated-while-off");

const second = createRuntime();
extension(second.pi);
await second.handlers.get("session_start")?.({ reason: "reload" }, ctx);
await first.handlers.get("session_shutdown")?.({ reason: "reload" }, ctx);
sm.setDefaultModel("blocked-after-old-shutdown");
assert.equal(sm.getDefaultModel(), "delegated-while-off", "old shutdown must not deactivate the new v1-wrapper owner");

await second.handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
assert.equal(state.enabled, false);
assert.equal(state.configured, true);
sm.setDefaultModel("delegated-after-shutdown");
assert.equal(sm.getDefaultModel(), "delegated-after-shutdown", "v1 wrappers must delegate with no active owner");

const third = createRuntime();
extension(third.pi);
await third.handlers.get("session_start")?.({ reason: "next-session" }, ctx);
assert.equal(state.enabled, true, "the next session must reactivate the persisted ON preference");
sm.setDefaultModel("blocked-in-next-session");
assert.equal(sm.getDefaultModel(), "delegated-after-shutdown");
await third.handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);

rmSync(agentDir, { recursive: true, force: true });
console.log("PASS: v1 wrappers follow migrated preference and active-owner lifecycle");
