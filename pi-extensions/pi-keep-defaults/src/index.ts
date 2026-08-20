import { readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getAgentDir, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installSettingsPatch, type SettingsPatchResult } from "./settings-patch.ts";

/**
 * pi-keep-defaults
 *
 * The process-global SettingsManager patch blocks known default-setting write
 * paths. A session-scoped file guard restores protected fields if another path
 * writes them. Background resources begin at session_start and are owned by
 * that factory instance until session_shutdown.
 */

const STATE = Symbol.for("pi-keep-defaults.state");
const PROTECTED_FIELDS = ["defaultProvider", "defaultModel", "defaultThinkingLevel"] as const;
const DEBOUNCE_MS = 60;

type ProtectedField = (typeof PROTECTED_FIELDS)[number];
type NotifyUI = { notify(message: string, level?: "info" | "warning" | "error"): unknown };
type DebounceTimer = ReturnType<typeof setTimeout>;

interface SessionGuard {
	owner: symbol;
	settingsPath: string;
	desired: Partial<Record<ProtectedField, string | undefined>>;
	ui: NotifyUI;
	watcher?: FSWatcher;
	debounceTimer?: DebounceTimer;
}

interface KeepDefaultsState {
	version?: 2;
	/** Effective protection for the active session; process-global wrappers read this field. */
	enabled: boolean;
	/** Process-persistent user preference, applied when a session becomes active. */
	configured?: boolean;
	current?: SessionGuard;
	// v1 state fields are retained only so session_start can dispose a watcher
	// and neutralize an untracked debounce left alive by an in-process upgrade.
	watcher?: FSWatcher;
	settingsPath?: string;
	desired?: Partial<Record<ProtectedField, string | undefined>>;
	ui?: NotifyUI;
}

function getState(): KeepDefaultsState {
	const root = globalThis as typeof globalThis & Record<symbol, unknown>;
	const existing = root[STATE];
	if (existing && typeof existing === "object") {
		const state = existing as KeepDefaultsState;
		if (state.version === 2) {
			if (typeof state.configured !== "boolean") {
				state.configured = typeof state.enabled === "boolean" ? state.enabled : true;
			}
			if (typeof state.enabled !== "boolean") state.enabled = false;
		} else if (typeof state.enabled !== "boolean") {
			state.enabled = true;
		}
		return state;
	}

	// The preference defaults to ON, but wrappers must delegate until
	// session_start establishes an active owner.
	const state: KeepDefaultsState = { version: 2, enabled: false, configured: true };
	root[STATE] = state;
	return state;
}

function migrateLegacyState(state: KeepDefaultsState): KeepDefaultsState {
	if (state.version === 2) return state;

	const root = globalThis as typeof globalThis & Record<symbol, unknown>;
	// More than one factory can have captured the same legacy object. Once the
	// first session migrates it, later factories must join that v2 state rather
	// than replacing its active owner.
	if (root[STATE] !== state) return getState();

	const configured = state.enabled;
	if (state.watcher) {
		try {
			state.watcher.close();
		} catch {
			// Legacy v1 watcher cleanup is best-effort.
		}
	}
	state.watcher = undefined;
	state.ui = undefined;
	state.desired = {};
	// Permanently disable the old object: every already queued v1 debounce
	// callback closes over this object and begins by checking enabled.
	state.enabled = false;

	// Legacy v1 wrappers read global state.enabled. Keep that field inactive
	// until beginSession establishes a current owner, while preserving the
	// user's old on/off preference separately.
	const migrated: KeepDefaultsState = { version: 2, enabled: false, configured };
	root[STATE] = migrated;
	return migrated;
}

function isCurrent(state: KeepDefaultsState, session: SessionGuard): boolean {
	return state.current === session && state.current.owner === session.owner;
}

function notifyWarning(session: SessionGuard, message: string): void {
	try {
		console.warn(message);
	} catch {
		// Warning delivery must never turn a watcher failure into a Pi crash.
	}
	try {
		session.ui.notify(message, "warning");
	} catch {
		// UI adapters are external to the watcher callback; degrade silently.
	}
}

function notify(session: SessionGuard, message: string, level: "info" | "warning" | "error"): void {
	try {
		session.ui.notify(message, level);
	} catch {
		// Timer and watcher callbacks must not surface UI adapter failures.
	}
}

/**
 * A syntactically valid JSON value is not necessarily a settings object.
 * Ignore primitives and arrays rather than letting a watcher callback throw
 * or coercing a user-owned file into a different shape.
 */
function readSettingsObject(settingsPath: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

/** Capture the protected values currently present in settings.json. */
function captureDesired(session: SessionGuard): void {
	const parsed = readSettingsObject(session.settingsPath);
	if (!parsed) {
		// A missing, malformed, or non-object JSON file has no baseline yet. The
		// first valid object observed by the guard is adopted and then frozen.
		return;
	}
	for (const field of PROTECTED_FIELDS) {
		const value = parsed[field];
		session.desired[field] = typeof value === "string" ? value : undefined;
	}
}

/**
 * Restore protected fields to this session's baseline. Ownership is checked
 * before touching the file so a stale debounce callback cannot affect a
 * replacement extension instance.
 */
function checkAndRestore(state: KeepDefaultsState, session: SessionGuard): void {
	if (!state.enabled || !isCurrent(state, session)) return;

	const parsed = readSettingsObject(session.settingsPath);
	if (!parsed) return;

	const reverted: ProtectedField[] = [];
	const merged: Record<string, unknown> = { ...parsed };
	for (const field of PROTECTED_FIELDS) {
		const fileValue = typeof parsed[field] === "string" ? (parsed[field] as string) : undefined;
		if (fileValue === session.desired[field]) continue;
		if (session.desired[field] === undefined) {
			session.desired[field] = fileValue;
			continue;
		}
		merged[field] = session.desired[field];
		reverted.push(field);
	}
	if (reverted.length === 0 || !isCurrent(state, session)) return;

	const tmpPath = `${session.settingsPath}.keep-defaults.tmp`;
	try {
		writeFileSync(tmpPath, JSON.stringify(merged, null, 2), "utf8");
		if (!isCurrent(state, session)) return;
		renameSync(tmpPath, session.settingsPath);
		notify(
			session,
			`pi-keep-defaults: restored ${reverted.join(", ")} in settings.json (defaults are frozen).`,
			"warning",
		);
	} catch {
		// Best effort. A later file event can retry without risking an
		// unparseable or partially written settings file.
	}
}

function stopSessionResources(session: SessionGuard): void {
	if (session.debounceTimer) {
		clearTimeout(session.debounceTimer);
		session.debounceTimer = undefined;
	}
	const watcher = session.watcher;
	session.watcher = undefined;
	if (watcher) {
		try {
			watcher.close();
		} catch {
			// close() is best-effort and this function is intentionally idempotent.
		}
	}
}

function stopGuardOwned(state: KeepDefaultsState, owner: symbol): void {
	const session = state.current;
	if (!session || session.owner !== owner) return;
	stopSessionResources(session);
}

function scheduleRestore(state: KeepDefaultsState, session: SessionGuard): void {
	if (!state.enabled || !isCurrent(state, session)) return;
	if (session.debounceTimer) clearTimeout(session.debounceTimer);

	const timer = setTimeout(() => {
		if (session.debounceTimer === timer) session.debounceTimer = undefined;
		if (!isCurrent(state, session)) return;
		checkAndRestore(state, session);
	}, DEBOUNCE_MS);
	timer.unref();
	session.debounceTimer = timer;
}

/** Start one watcher and at most one unref'ed debounce timer for the session. */
function startGuard(state: KeepDefaultsState, session: SessionGuard): void {
	if (!state.enabled || !isCurrent(state, session)) return;
	stopSessionResources(session);

	const directory = dirname(session.settingsPath);
	const settingsName = basename(session.settingsPath);
	let watcher: FSWatcher;
	try {
		watcher = watch(directory, (_eventType, filename) => {
			if (!isCurrent(state, session) || session.watcher !== watcher) return;
			if (filename !== null && filename.toString() !== settingsName) return;
			scheduleRestore(state, session);
		});
		session.watcher = watcher;
		watcher.on("error", (error) => {
			if (!isCurrent(state, session) || session.watcher !== watcher) return;
			stopSessionResources(session);
			notifyWarning(
				session,
				`pi-keep-defaults: settings.json file guard stopped after a watcher error; defaults are no longer protected from bypass writes (${error.message}).`,
			);
		});
	} catch (error) {
		stopSessionResources(session);
		notifyWarning(
			session,
			`pi-keep-defaults: could not start the settings.json file guard; defaults are no longer protected from bypass writes (${error instanceof Error ? error.message : String(error)}).`,
		);
	}
}

function beginSession(state: KeepDefaultsState, owner: symbol, ui: NotifyUI): SessionGuard {
	// A new runtime owns all resources from this point. Dispose any predecessor
	// first; its later shutdown and timer callbacks fail the ownership checks.
	if (state.current) stopSessionResources(state.current);

	const session: SessionGuard = {
		owner,
		settingsPath: join(getAgentDir(), "settings.json"),
		desired: {},
		ui,
	};
	state.current = session;
	state.enabled = state.configured !== false;
	captureDesired(session);
	if (state.enabled) startGuard(state, session);
	return session;
}

function registerCommand(pi: ExtensionAPI): void {
	pi.registerCommand("keep-defaults", {
		description: "Freeze default model/thinking in settings.json. Usage: /keep-defaults [on|off|status]",
		handler: async (args, ctx) => {
			const state = getState();
			const session = state.current;
			const arg = args.trim().toLowerCase();

			if (arg === "on") {
				state.configured = true;
				state.enabled = session !== undefined;
				if (session) {
					captureDesired(session);
					startGuard(state, session);
				}
				ctx.ui.notify(
					"pi-keep-defaults: protection ON — switching model/thinking will not change settings.json defaults.",
					"info",
				);
			} else if (arg === "off") {
				state.configured = false;
				state.enabled = false;
				if (session) stopSessionResources(session);
				ctx.ui.notify(
					"pi-keep-defaults: protection OFF — /model and thinking changes will update settings.json again.",
					"warning",
				);
			} else if (arg === "" || arg === "status") {
				const desired = session?.desired ?? {};
				ctx.ui.notify(
					`pi-keep-defaults: ${state.enabled ? "ON" : "OFF"} | defaultProvider=${desired.defaultProvider ?? "(unset)"}, defaultModel=${desired.defaultModel ?? "(unset)"}, defaultThinkingLevel=${desired.defaultThinkingLevel ?? "(unset)"}`,
					"info",
				);
			} else {
				ctx.ui.notify("pi-keep-defaults: unknown argument. Usage: /keep-defaults [on|off|status]", "warning");
			}
		},
	});
}

function warnPatchFallback(result: SettingsPatchResult, ui?: NotifyUI): void {
	const message = `pi-keep-defaults: SettingsManager patch is unavailable (${result.reason ?? "incompatible internal setter shape"}); using only the session-scoped settings.json file guard.`;
	if (ui) {
		try {
			ui.notify(message, "warning");
		} catch {
			// Compatibility fallback remains active even if warning UI fails.
		}
	} else {
		try {
			console.warn(message);
		} catch {
			// Console replacement must not prevent extension registration.
		}
	}
}

export default function keepDefaultsExtension(pi: ExtensionAPI): void {
	let state = getState();
	const owner = Symbol("pi-keep-defaults.factory-owner");
	const patchResult = installSettingsPatch(SettingsManager, () => getState().enabled);
	if (!patchResult.installed) warnPatchFallback(patchResult);

	pi.on("session_start", (_event, ctx) => {
		state = migrateLegacyState(state);
		beginSession(state, owner, ctx.ui);
		if (!patchResult.installed) warnPatchFallback(patchResult, ctx.ui);
	});

	pi.on("session_shutdown", () => {
		if (state.current?.owner !== owner) return;
		stopGuardOwned(state, owner);
		state.current = undefined;
		// Leave the process-global wrappers installed for idempotent reloads,
		// but make them delegate when this owner has no successor session.
		state.enabled = false;
	});

	registerCommand(pi);
}
