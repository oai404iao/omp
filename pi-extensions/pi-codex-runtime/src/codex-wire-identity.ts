import {
	canonicalAgentName, isUuidV7, parseCodexThreadIdentity, uuidV7,
	type CodexThreadIdentity, type CodexWireIdentity, type CodexTurnIdentity,
	type CodexTurnAttribution, type CodexRequestIdentity,
} from "./codex-identity-types.js";
import { codexInstallationIdFor, resetCodexInstallationId } from "./codex-installation.js";
export * from "./codex-identity-types.js";
export { codexInstallationIdFor, setCodexInstallationId } from "./codex-installation.js";

interface RuntimeSession {
	identity: CodexThreadIdentity;
	activeTurn?: CodexTurnIdentity;
	pendingTurnState?: string;
	extraThreads: Map<string, CodexThreadIdentity>;
}
const RUNTIME_SYMBOL = Symbol.for("@oai404iao/pi-codex/identity-runtime/v1");
function sessions(): Map<string, RuntimeSession> {
	const global = globalThis as typeof globalThis & { [RUNTIME_SYMBOL]?: { sessions: Map<string, RuntimeSession> } };
	return (global[RUNTIME_SYMBOL] ??= { sessions: new Map() }).sessions;
}

function newRootIdentity(piSessionId: string, forkedFromThreadId?: string): CodexThreadIdentity {
	const threadId = uuidV7();
	const contextWindowId = uuidV7();
	return {
		version: 1, piSessionId, sessionId: threadId, threadId,
		windowId: `${threadId}:0`, contextWindowId, firstWindowId: contextWindowId, windowNumber: 0,
		...(forkedFromThreadId ? { forkedFromThreadId } : {}),
		agentName: "/root",
	};
}
export function createCodexRootIdentity(piSessionId: string, options: { forkedFromThreadId?: string } = {}): CodexThreadIdentity {
	return newRootIdentity(piSessionId, options.forkedFromThreadId);
}
export function createCodexChildIdentity(
	piSessionId: string, parent: CodexThreadIdentity,
	options: { relation: "spawn" | "fork"; agentName?: string; subagentKind?: string },
): CodexThreadIdentity {
	const identity = newRootIdentity(piSessionId);
	const subagentKind = options.subagentKind === "collab_spawn" ? "thread_spawn" : options.subagentKind ?? "thread_spawn";
	return {
		...identity, sessionId: parent.sessionId, parentThreadId: parent.threadId,
		...(options.relation === "fork" ? { forkedFromThreadId: parent.threadId } : {}),
		agentName: canonicalAgentName(options.agentName),
		subagentKind, subagentHeader: subagentKind === "thread_spawn" ? "collab_spawn" : subagentKind,
	};
}
export function registerCodexThreadIdentity(identity: CodexThreadIdentity): CodexThreadIdentity {
	const parsed = parseCodexThreadIdentity(identity);
	const previous = sessions().get(parsed.piSessionId);
	sessions().set(parsed.piSessionId, {
		identity: structuredClone(parsed), activeTurn: previous?.activeTurn,
		pendingTurnState: previous?.pendingTurnState, extraThreads: previous?.extraThreads ?? new Map(),
	});
	return structuredClone(parsed);
}
export function codexThreadIdentityFor(piSessionId: string | undefined): CodexThreadIdentity | undefined {
	const identity = piSessionId ? sessions().get(piSessionId)?.identity : undefined;
	return identity ? structuredClone(identity) : undefined;
}
function ensureFallbackSession(piSessionId: string): RuntimeSession {
	let state = sessions().get(piSessionId);
	if (!state) {
		state = { identity: newRootIdentity(piSessionId), extraThreads: new Map() };
		sessions().set(piSessionId, state);
	}
	return state;
}
function wireIdentity(identity: CodexThreadIdentity): CodexWireIdentity {
	return {
		sessionId: identity.sessionId, threadId: identity.threadId,
		windowId: identity.windowId, windowNumber: identity.windowNumber, contextWindowId: identity.contextWindowId,
	};
}
export function resolveCodexWireIdentity(piSessionId: string, threadKey?: string): CodexWireIdentity {
	const session = ensureFallbackSession(piSessionId);
	if (!threadKey || threadKey === piSessionId || threadKey === session.identity.threadId) return wireIdentity(session.identity);
	let thread = session.extraThreads.get(threadKey);
	if (!thread) {
		thread = { ...newRootIdentity(piSessionId), sessionId: session.identity.sessionId };
		session.extraThreads.set(threadKey, thread);
	}
	return wireIdentity(thread);
}
function advanceWindow(identity: CodexThreadIdentity): void {
	identity.previousWindowId = identity.contextWindowId;
	identity.contextWindowId = uuidV7();
	identity.windowNumber++;
	identity.windowId = `${identity.threadId}:${identity.windowNumber}`;
}
export function rotateCodexWindowId(piSessionId: string, threadKey?: string): void {
	const session = ensureFallbackSession(piSessionId);
	const identity = threadKey && threadKey !== piSessionId && threadKey !== session.identity.threadId
		? session.extraThreads.get(threadKey) : session.identity;
	if (!identity) {
		resolveCodexWireIdentity(piSessionId, threadKey);
		return rotateCodexWindowId(piSessionId, threadKey);
	}
	advanceWindow(identity);
}
export function advanceCodexWindow(piSessionId: string, compactionEntryId?: string): CodexThreadIdentity {
	const state = ensureFallbackSession(piSessionId);
	if (compactionEntryId && state.identity.lastCompactionEntryId === compactionEntryId) return structuredClone(state.identity);
	advanceWindow(state.identity);
	if (compactionEntryId) state.identity.lastCompactionEntryId = compactionEntryId;
	return structuredClone(state.identity);
}
export function captureCodexTurnAttribution(piSessionId: string | undefined): CodexTurnAttribution {
	const turn = currentCodexTurn(piSessionId);
	return turn ? { parentTurnId: turn.turnId, rootTurnId: turn.rootTurnId ?? turn.turnId } : {};
}
export function beginCodexTurn(
	piSessionId: string,
	options: { parentPiSessionId?: string; turnId?: string; startedAtMs?: number; attribution?: CodexTurnAttribution } = {},
): CodexTurnIdentity {
	const state = ensureFallbackSession(piSessionId);
	if (state.activeTurn) return structuredClone(state.activeTurn);
	const attribution = options.attribution ?? captureCodexTurnAttribution(options.parentPiSessionId);
	const turnId = isUuidV7(options.turnId) ? options.turnId : uuidV7();
	const turn: CodexTurnIdentity = {
		turnId, startedAtMs: options.startedAtMs ?? Date.now(),
		...(attribution.parentTurnId ? { parentTurnId: attribution.parentTurnId } : {}),
		rootTurnId: attribution.rootTurnId ?? attribution.parentTurnId ?? turnId,
		...(state.pendingTurnState ? { turnState: state.pendingTurnState } : {}),
	};
	delete state.pendingTurnState;
	state.activeTurn = turn;
	return structuredClone(turn);
}
export function currentCodexTurn(piSessionId: string | undefined): CodexTurnIdentity | undefined {
	const turn = piSessionId ? sessions().get(piSessionId)?.activeTurn : undefined;
	return turn ? structuredClone(turn) : undefined;
}
export function endCodexTurn(piSessionId: string, turnId?: string): void {
	const state = sessions().get(piSessionId);
	if (state?.activeTurn && (!turnId || state.activeTurn.turnId === turnId)) delete state.activeTurn;
}
export function codexTurnStateFor(piSessionId: string): string | undefined {
	return sessions().get(piSessionId)?.activeTurn?.turnState;
}
export function captureCodexTurnState(piSessionId: string, token: string | undefined): void {
	if (typeof token !== "string" || !token.trim()) return;
	const state = ensureFallbackSession(piSessionId);
	if (state.activeTurn) state.activeTurn.turnState ??= token.trim();
	else state.pendingTurnState ??= token.trim();
}
function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = metadata?.[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
export function resolveCodexRequestIdentity(
	piSessionId: string | undefined, metadata: Record<string, unknown> | undefined,
	requestKind: CodexRequestIdentity["requestKind"] = "turn",
): CodexRequestIdentity | undefined {
	const state = piSessionId ? ensureFallbackSession(piSessionId) : undefined;
	const identity = state?.identity;
	const explicitSessionId = metadataString(metadata, "session_id");
	const explicitThreadId = metadataString(metadata, "thread_id");
	const sessionId = isUuidV7(explicitSessionId) ? explicitSessionId : identity?.sessionId;
	const threadId = isUuidV7(explicitThreadId) ? explicitThreadId : identity?.threadId;
	if (!sessionId || !threadId) return undefined;
	const explicitWindowId = metadataString(metadata, "window_id") ?? metadataString(metadata, "x-codex-window-id");
	const numberFromWindow = explicitWindowId?.startsWith(`${threadId}:`) ? Number(explicitWindowId.slice(threadId.length + 1)) : undefined;
	const explicitNumber = metadata?.window_number ?? numberFromWindow;
	const windowNumber = typeof explicitNumber === "number" && Number.isSafeInteger(explicitNumber) && explicitNumber >= 0
		? explicitNumber : identity?.windowNumber ?? 0;
	const explicitContext = metadataString(metadata, "context_window_id") ?? (isUuidV7(explicitWindowId) ? explicitWindowId : undefined);
	const contextWindowId = isUuidV7(explicitContext) ? explicitContext : identity?.contextWindowId ?? uuidV7();
	let turn = state?.activeTurn;
	const explicitTurnId = metadataString(metadata, "turn_id");
	if (isUuidV7(explicitTurnId) && turn?.turnId !== explicitTurnId) {
		turn = { turnId: explicitTurnId, startedAtMs: Date.now(), rootTurnId: explicitTurnId,
			...(state?.pendingTurnState ? { turnState: state.pendingTurnState } : {}) };
		if (state) { state.activeTurn = turn; delete state.pendingTurnState; }
	} else if (!turn && requestKind !== "prewarm" && piSessionId) turn = beginCodexTurn(piSessionId);
	const explicit = (key: string, fallback?: string) => {
		const value = metadataString(metadata, key);
		return isUuidV7(value) ? value : fallback;
	};
	const parentThreadId = explicit("parent_thread_id", identity?.parentThreadId);
	const forkedFromThreadId = explicit("forked_from_thread_id", identity?.forkedFromThreadId);
	const parentTurnId = explicit("parent_turn_id", turn?.parentTurnId);
	const rootTurnId = explicit("root_turn_id", turn?.rootTurnId);
	return {
		installationId: codexInstallationIdFor(), sessionId, threadId, windowId: `${threadId}:${windowNumber}`,
		windowNumber, contextWindowId, turnId: turn?.turnId ?? "", requestKind,
		...(turn ? { turnStartedAtMs: turn.startedAtMs } : {}),
		...(parentThreadId ? { parentThreadId } : {}),
		...(forkedFromThreadId ? { forkedFromThreadId } : {}),
		...(parentTurnId ? { parentTurnId } : {}),
		...(rootTurnId ? { rootTurnId } : {}),
		...(identity?.agentName ? { agentName: identity.agentName } : {}),
		...(identity?.subagentKind ? { subagentKind: identity.subagentKind } : {}),
		...(identity?.subagentHeader ? { subagentHeader: identity.subagentHeader } : {}),
		...(turn?.turnState ? { turnState: turn.turnState } : {}),
	};
}
export function resetCodexWireState(): void { sessions().clear(); resetCodexInstallationId(); }
export function codexWireIdentityCount(): number { return sessions().size; }
