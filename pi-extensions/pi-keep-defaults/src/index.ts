import { readFileSync, renameSync, watch, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getAgentDir, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi-keep-defaults
 *
 * Stops Pi from rewriting `defaultProvider` / `defaultModel` /
 * `defaultThinkingLevel` in the global settings.json when the user switches
 * models or toggles thinking inside a session.
 *
 * Two layers:
 *
 * 1. Runtime patch (primary): `SettingsManager`'s default-value setters are
 *    intercepted so in-session model/thinking changes never touch the
 *    defaults (memory or disk). This covers every current write path:
 *    `/model`, Ctrl+P cycling, the model picker UI, RPC, and thinking-level
 *    changes triggered by model switches or keybindings.
 *
 * 2. File guard (backstop): the global settings.json is watched. If the
 *    protected fields are ever written by some other path, they are merged
 *    back to the baseline and the user is notified.
 *
 * Toggle with `/keep-defaults on|off|status`.
 */

const PATCHED = Symbol.for("pi-keep-defaults.settings-manager-patched");
const PATCH_VERSION = 1;
const STATE = Symbol.for("pi-keep-defaults.state");

const PROTECTED_FIELDS = ["defaultProvider", "defaultModel", "defaultThinkingLevel"] as const;
type ProtectedField = (typeof PROTECTED_FIELDS)[number];

interface KeepDefaultsState {
	/** Whether writes to the protected fields are blocked/reverted. */
	enabled: boolean;
	/** Absolute path of the global settings.json. */
	settingsPath: string;
	/**
	 * Baseline values captured at startup. `undefined` means the field was
	 * absent and has no baseline yet; the first value observed later is
	 * adopted as the baseline and then frozen.
	 */
	desired: Partial<Record<ProtectedField, string | undefined>>;
	/** Latest UI handle for notifications (refreshed on every session_start). */
	ui?: { notify(message: string, level?: string): unknown };
	watcher?: ReturnType<typeof watch>;
}

function getState(): KeepDefaultsState {
	const root = globalThis as typeof globalThis & Record<symbol, unknown>;
	let state = root[STATE] as KeepDefaultsState | undefined;
	if (!state) {
		state = {
			enabled: true,
			settingsPath: join(getAgentDir(), "settings.json"),
			desired: {},
		};
		root[STATE] = state;
	}
	return state;
}

/** Read the current file values as the baseline for the protected fields. */
function captureDesired(state: KeepDefaultsState): void {
	try {
		const parsed = JSON.parse(readFileSync(state.settingsPath, "utf8")) as Record<string, unknown>;
		for (const field of PROTECTED_FIELDS) {
			const value = parsed[field];
			state.desired[field] = typeof value === "string" ? value : undefined;
		}
	} catch {
		// settings.json missing or unreadable; keep the previous baseline.
	}
}

/**
 * Patch SettingsManager so in-session model/thinking changes never touch the
 * defaults while protection is enabled. Idempotent across /reload.
 */
function installSettingsPatch(): boolean {
	const proto = (SettingsManager as unknown as { prototype?: Record<PropertyKey, unknown> }).prototype;
	if (!proto) return false;
	if (proto[PATCHED] === PATCH_VERSION) return true;

	const methods = [
		"setDefaultModelAndProvider",
		"setDefaultProvider",
		"setDefaultModel",
		"setDefaultThinkingLevel",
	] as const;

	for (const name of methods) {
		const original = proto[name];
		if (typeof original !== "function") continue;
		proto[name] = function patchedDefaultSetter(this: unknown, ...args: unknown[]) {
			const state = getState();
			if (state.enabled) {
				// Protection on: model/thinking switches must not rewrite the defaults.
				return undefined;
			}
			return Reflect.apply(original, this, args);
		};
	}
	proto[PATCHED] = PATCH_VERSION;
	return true;
}

/**
 * Read the settings file; if a protected field differs from the baseline,
 * either adopt it as the baseline (first observed value, never seen before)
 * or merge the baseline back in and rewrite the file atomically.
 */
function checkAndRestore(state: KeepDefaultsState): void {
	if (!state.enabled) return;

	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(readFileSync(state.settingsPath, "utf8")) as Record<string, unknown>;
	} catch {
		return; // file missing or malformed; never touch what we cannot parse
	}

	const reverted: ProtectedField[] = [];
	const merged: Record<string, unknown> = { ...parsed };
	for (const field of PROTECTED_FIELDS) {
		const fileValue = typeof parsed[field] === "string" ? (parsed[field] as string) : undefined;
		if (fileValue === state.desired[field]) continue;
		if (state.desired[field] === undefined) {
			// No baseline yet: adopt the first observed value, then freeze it.
			state.desired[field] = fileValue;
			continue;
		}
		merged[field] = state.desired[field];
		reverted.push(field);
	}
	if (reverted.length === 0) return;

	const tmpPath = `${state.settingsPath}.keep-defaults.tmp`;
	try {
		writeFileSync(tmpPath, JSON.stringify(merged, null, 2), "utf8");
		renameSync(tmpPath, state.settingsPath);
		state.ui?.notify?.(`pi-keep-defaults: restored ${reverted.join(", ")} in settings.json (defaults are frozen).`, "warning");
	} catch {
		// Best effort; the watcher retries on the next change.
	}
}

/** Watch the settings directory and revert any write to the protected fields. */
function startGuard(state: KeepDefaultsState): void {
	stopGuard(state);
	const dir = dirname(state.settingsPath);
	const base = basename(state.settingsPath);
	state.watcher = watch(dir, (_eventType, filename) => {
		if (filename !== null && filename !== base) return;
		setTimeout(() => checkAndRestore(state), 60);
	});
}

function stopGuard(state: KeepDefaultsState): void {
	state.watcher?.close();
	state.watcher = undefined;
}

function registerCommand(pi: ExtensionAPI): void {
	pi.registerCommand("keep-defaults", {
		description: "Freeze default model/thinking in settings.json. Usage: /keep-defaults [on|off|status]",
		handler: async (args, ctx) => {
			const state = getState();
			const arg = args.trim().toLowerCase();

			if (arg === "on") {
				state.enabled = true;
				captureDesired(state);
				checkAndRestore(state);
				ctx.ui.notify("pi-keep-defaults: protection ON — switching model/thinking will not change settings.json defaults.", "info");
			} else if (arg === "off") {
				state.enabled = false;
				ctx.ui.notify("pi-keep-defaults: protection OFF — /model and thinking changes will update settings.json again.", "warning");
			} else if (arg === "" || arg === "status") {
				const d = state.desired;
				ctx.ui.notify(
					`pi-keep-defaults: ${state.enabled ? "ON" : "OFF"} | defaultProvider=${d.defaultProvider ?? "(unset)"}, defaultModel=${d.defaultModel ?? "(unset)"}, defaultThinkingLevel=${d.defaultThinkingLevel ?? "(unset)"}`,
					"info",
				);
			} else {
				ctx.ui.notify("pi-keep-defaults: unknown argument. Usage: /keep-defaults [on|off|status]", "warning");
			}
		},
	});
}

export default function keepDefaultsExtension(pi: ExtensionAPI): void {
	const state = getState();

	// Re-point at the current agent dir in case it changed between reloads.
	state.settingsPath = join(getAgentDir(), "settings.json");

	const patchInstalled = installSettingsPatch();
	if (!patchInstalled) {
		console.warn("pi-keep-defaults: could not patch SettingsManager; the file guard is still active.");
	}

	// Baseline = the defaults configured when pi started.
	captureDesired(state);

	// Backstop: revert any settings.json write that touches the protected fields.
	startGuard(state);

	pi.on("session_start", (_event, ctx) => {
		state.ui = ctx.ui;
	});

	pi.on("session_shutdown", () => {
		state.ui = undefined;
	});

	registerCommand(pi);
}
