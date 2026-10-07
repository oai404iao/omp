import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { loadSettings } from "./settings.js";

export const FAST_MODE_CUSTOM_TYPE = "pi-codex/fast-mode";

export interface FastModeSessionView {
	getSessionId(): string;
	getBranch?(): SessionEntry[];
	getEntries?(): SessionEntry[];
}

interface FastModeState {
	version: 1;
	sessionId: string;
	enabled: boolean;
	rootSessionId?: string;
}

interface SessionState {
	value: FastModeState;
	owner?: object;
}

const STATE = Symbol.for("@oai404iao/pi-codex/fast-mode/v1");
const LIFECYCLE = Symbol.for("@oai404iao/pi-codex/fast-mode-lifecycle/v1");
const CHANNEL = "@oai404iao/pi-codex:fast-mode-lifecycle:v1";

interface Lifecycle {
	parent?: FastModeSessionView;
	closed: boolean;
}

function sessions(): Map<string, SessionState> {
	const global = globalThis as typeof globalThis & { [STATE]?: Map<string, SessionState> };
	return global[STATE] ??= new Map();
}

function readState(session: FastModeSessionView): FastModeState | undefined {
	const entries = session.getBranch?.() ?? session.getEntries?.() ?? [];
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== FAST_MODE_CUSTOM_TYPE) continue;
		const data = entry.data as Partial<FastModeState> | null;
		if (data?.version !== 1 || typeof data.enabled !== "boolean" || typeof data.sessionId !== "string") continue;
		if (data.rootSessionId !== undefined && typeof data.rootSessionId !== "string") continue;
		return data as FastModeState;
	}
	return undefined;
}

export function sessionFastMode(sessionId: string | undefined, defaultValue: boolean): boolean {
	const state = sessionId ? sessions().get(sessionId)?.value : undefined;
	if (!state) return defaultValue;
	return (state.rootSessionId ? sessions().get(state.rootSessionId)?.value.enabled : undefined) ?? state.enabled;
}

export function setSessionFastMode(
	pi: ExtensionAPI,
	session: FastModeSessionView,
	enabled: boolean,
): void {
	const sessionId = session.getSessionId();
	const previous = sessions().get(sessionId);
	if (previous?.value.rootSessionId) {
		throw new Error("Subagent Fast mode follows the main agent; switch it in the main session.");
	}
	const state: FastModeState = { version: 1, sessionId, enabled };
	pi.appendEntry(FAST_MODE_CUSTOM_TYPE, state);
	sessions().set(sessionId, { value: state, owner: previous?.owner });
}

export function installFastModeLifecycle(pi: ExtensionAPI, parentSession?: FastModeSessionView): void {
	const api = pi as ExtensionAPI & { [LIFECYCLE]?: Lifecycle };
	let lifecycle = api[LIFECYCLE];
	if (!lifecycle || lifecycle.closed) {
		pi.events?.emit(CHANNEL, { accept(candidate: Lifecycle) {
			if (!candidate.closed) lifecycle = candidate;
		} });
	}
	if (lifecycle && !lifecycle.closed) {
		if (parentSession) lifecycle.parent = parentSession;
		api[LIFECYCLE] = lifecycle;
		return;
	}
	const binding: Lifecycle = { parent: parentSession, closed: false };
	api[LIFECYCLE] = binding;
	const unsubscribe = pi.events?.on(CHANNEL, value => {
		const request = value as { accept?: (candidate: Lifecycle) => void } | undefined;
		if (!binding.closed) request?.accept?.(binding);
	});
	const owner = {};
	let ownedSessionId: string | undefined;
	const release = () => {
		if (ownedSessionId && sessions().get(ownedSessionId)?.owner === owner) sessions().delete(ownedSessionId);
		ownedSessionId = undefined;
	};
	const restore = (session: FastModeSessionView | undefined) => {
		if (!session?.getSessionId) return;
		const sessionId = session.getSessionId();
		const saved = readState(session);
		let rootSessionId: string | undefined;
		let enabled = saved
			? sessionFastMode(saved.rootSessionId, saved.enabled)
			: loadSettings().fastMode;
		if (binding.parent) {
			const parentId = binding.parent.getSessionId();
			const parent = sessions().get(parentId)?.value ?? readState(binding.parent);
			rootSessionId = parent?.sessionId === parentId ? parent.rootSessionId ?? parentId : parentId;
			enabled = sessionFastMode(rootSessionId, parent?.enabled ?? enabled);
		}
		const state: FastModeState = {
			version: 1, sessionId, enabled,
			...(rootSessionId && rootSessionId !== sessionId ? { rootSessionId } : {}),
		};
		release();
		sessions().set(sessionId, { value: state, owner });
		ownedSessionId = sessionId;
		if (!saved || saved.sessionId !== sessionId || saved.rootSessionId !== state.rootSessionId || saved.enabled !== enabled) {
			pi.appendEntry?.(FAST_MODE_CUSTOM_TYPE, state);
		}
	};
	pi.on("session_start", (_event, ctx) => restore(ctx.sessionManager));
	pi.on("session_tree", (_event, ctx) => restore(ctx.sessionManager));
	pi.on("before_agent_start", (_event, ctx) => {
		if (binding.parent) restore(ctx.sessionManager);
	});
	pi.on("session_shutdown", () => {
		release();
		binding.closed = true;
		unsubscribe?.();
	});
}
