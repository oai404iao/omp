import { uuidv7 } from "@earendil-works/pi-ai";
import {
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Persistent Codex identity written by pi-codex-minimal-tools.
 *
 * `piSessionId` is only the lookup/binding key for Pi's session file. It is
 * never emitted on the Codex wire.
 */
export interface CodexThreadIdentity {
	version: 1;
	piSessionId: string;
	sessionId: string;
	threadId: string;
	windowId: string;
	firstWindowId: string;
	previousWindowId?: string;
	windowNumber: number;
	parentThreadId?: string;
	forkedFromThreadId?: string;
	agentName?: string;
	subagentKind?: string;
	lastCompactionEntryId?: string;
}

export interface CodexWireIdentity {
	sessionId: string;
	threadId: string;
	windowId: string;
}

export interface CodexTurnIdentity {
	turnId: string;
	startedAtMs: number;
	parentTurnId?: string;
	rootTurnId?: string;
	turnState?: string;
}

export interface CodexRequestIdentity extends CodexWireIdentity {
	installationId: string;
	turnId: string;
	turnStartedAtMs?: number;
	requestKind: "turn" | "compaction" | "prewarm";
	parentThreadId?: string;
	forkedFromThreadId?: string;
	parentTurnId?: string;
	rootTurnId?: string;
	agentName?: string;
	subagentKind?: string;
	turnState?: string;
}

interface RuntimeSession {
	identity: CodexThreadIdentity;
	activeTurn?: CodexTurnIdentity;
	pendingTurnState?: string;
	extraThreads: Map<string, CodexThreadIdentity>;
}

interface CodexIdentityRuntime {
	sessions: Map<string, RuntimeSession>;
	installationId?: string;
	installationPath?: string;
}

const RUNTIME_SYMBOL = Symbol.for("@oai404iao/pi-codex/identity-runtime/v1");
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_V7_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTALLATION_UUID_V4_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function runtime(): CodexIdentityRuntime {
	const globals = globalThis as typeof globalThis & {
		[RUNTIME_SYMBOL]?: CodexIdentityRuntime;
	};
	if (!globals[RUNTIME_SYMBOL]) {
		globals[RUNTIME_SYMBOL] = {
			sessions: new Map(),
		};
	}
	return globals[RUNTIME_SYMBOL];
}

/** Pi-owned identities are generated as RFC 9562 UUIDv7 values. */
export function uuidV7(): string {
	return uuidv7();
}

function uuidV4(): string {
	if (typeof globalThis.crypto?.randomUUID === "function") {
		return globalThis.crypto.randomUUID();
	}
	const bytes = new Uint8Array(16);
	if (typeof globalThis.crypto?.getRandomValues === "function") {
		globalThis.crypto.getRandomValues(bytes);
	} else {
		for (let index = 0; index < bytes.length; index++) {
			bytes[index] = Math.floor(Math.random() * 256);
		}
	}
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isUuid(value: unknown): value is string {
	return typeof value === "string" && UUID_PATTERN.test(value);
}

export function isUuidV7(value: unknown): value is string {
	return typeof value === "string" && UUID_V7_PATTERN.test(value);
}

/**
 * Codex has one installation id for the installation, not one per Pi session.
 *
 * It is loaded and repaired synchronously because request payload assembly is
 * synchronous at this boundary.
 */
function installationIdPath(): string {
	return process.env.PI_CODEX_INSTALLATION_ID_PATH
		?? join(
			getAgentDir(),
			"pi-codex-minimal-tools",
			"installation_id",
		);
}

export function codexInstallationIdFor(_sessionKey?: string): string {
	const state = runtime();
	const path = installationIdPath();
	if (state.installationId && state.installationPath === path) {
		return state.installationId;
	}
	try {
		const persisted = readFileSync(path, "utf8").trim();
		if (INSTALLATION_UUID_V4_PATTERN.test(persisted)) {
			state.installationId = persisted;
			state.installationPath = path;
			return persisted;
		}
	} catch {
		// Missing/unreadable state is repaired below.
	}

	const generated = uuidV4();
	try {
		mkdirSync(dirname(path), { recursive: true });
		const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
		writeFileSync(temporary, `${generated}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		renameSync(temporary, path);
	} catch {
		// Read-only environments retain the installation id for this process.
	}
	state.installationId = generated;
	state.installationPath = path;
	return state.installationId;
}

export function setCodexInstallationId(value: string): void {
	if (!INSTALLATION_UUID_V4_PATTERN.test(value)) {
		throw new Error("Codex installation id must be a UUIDv4");
	}
	runtime().installationId = value;
	runtime().installationPath = installationIdPath();
}

function newRootIdentity(piSessionId: string, forkedFromThreadId?: string): CodexThreadIdentity {
	const threadId = uuidV7();
	const windowId = uuidV7();
	return {
		version: 1,
		piSessionId,
		sessionId: threadId,
		threadId,
		windowId,
		firstWindowId: windowId,
		windowNumber: 0,
		...(forkedFromThreadId ? { forkedFromThreadId } : {}),
		agentName: "root",
	};
}

export function createCodexRootIdentity(
	piSessionId: string,
	options: { forkedFromThreadId?: string } = {},
): CodexThreadIdentity {
	return newRootIdentity(piSessionId, options.forkedFromThreadId);
}

export function createCodexChildIdentity(
	piSessionId: string,
	parent: CodexThreadIdentity,
	options: {
		relation: "spawn" | "fork";
		agentName?: string;
		subagentKind?: string;
	},
): CodexThreadIdentity {
	const threadId = uuidV7();
	const windowId = uuidV7();
	return {
		version: 1,
		piSessionId,
		sessionId: parent.sessionId,
		threadId,
		windowId,
		firstWindowId: windowId,
		windowNumber: 0,
		parentThreadId: parent.threadId,
		...(options.relation === "fork"
			? { forkedFromThreadId: parent.threadId }
			: {}),
		...(options.agentName ? { agentName: options.agentName } : {}),
		subagentKind: options.subagentKind ?? "collab_spawn",
	};
}

function cloneIdentity(identity: CodexThreadIdentity): CodexThreadIdentity {
	return structuredClone(identity);
}

export function registerCodexThreadIdentity(identity: CodexThreadIdentity): CodexThreadIdentity {
	const parsed = parseCodexThreadIdentity(identity);
	const existing = runtime().sessions.get(parsed.piSessionId);
	runtime().sessions.set(parsed.piSessionId, {
		identity: cloneIdentity(parsed),
		activeTurn: existing?.activeTurn,
		pendingTurnState: existing?.pendingTurnState,
		extraThreads: existing?.extraThreads ?? new Map(),
	});
	return cloneIdentity(parsed);
}

export function codexThreadIdentityFor(piSessionId: string | undefined): CodexThreadIdentity | undefined {
	if (!piSessionId) return undefined;
	const value = runtime().sessions.get(piSessionId)?.identity;
	return value ? cloneIdentity(value) : undefined;
}

function ensureFallbackSession(piSessionId: string): RuntimeSession {
	let state = runtime().sessions.get(piSessionId);
	if (!state) {
		state = {
			identity: newRootIdentity(piSessionId),
			extraThreads: new Map(),
		};
		runtime().sessions.set(piSessionId, state);
	}
	return state;
}

/**
 * Compatibility resolver used by tests and legacy call sites.
 *
 * A root Codex thread has `sessionId === threadId`. Additional explicit
 * thread keys share that root session while receiving their own thread/window.
 */
export function resolveCodexWireIdentity(
	piSessionId: string,
	threadKey?: string,
): CodexWireIdentity {
	const session = ensureFallbackSession(piSessionId);
	if (
		!threadKey
		|| threadKey === piSessionId
		|| threadKey === session.identity.threadId
	) {
		return {
			sessionId: session.identity.sessionId,
			threadId: session.identity.threadId,
			windowId: session.identity.windowId,
		};
	}
	let thread = session.extraThreads.get(threadKey);
	if (!thread) {
		const threadId = uuidV7();
		const windowId = uuidV7();
		thread = {
			version: 1,
			piSessionId,
			sessionId: session.identity.sessionId,
			threadId,
			windowId,
			firstWindowId: windowId,
			windowNumber: 0,
		};
		session.extraThreads.set(threadKey, thread);
	}
	return {
		sessionId: thread.sessionId,
		threadId: thread.threadId,
		windowId: thread.windowId,
	};
}

export function rotateCodexWindowId(piSessionId: string, threadKey?: string): void {
	const session = ensureFallbackSession(piSessionId);
	const identity =
		threadKey && threadKey !== piSessionId && threadKey !== session.identity.threadId
			? session.extraThreads.get(threadKey)
			: session.identity;
	if (!identity) {
		resolveCodexWireIdentity(piSessionId, threadKey);
		return rotateCodexWindowId(piSessionId, threadKey);
	}
	identity.previousWindowId = identity.windowId;
	identity.windowId = uuidV7();
	identity.windowNumber += 1;
}

export function advanceCodexWindow(
	piSessionId: string,
	compactionEntryId?: string,
): CodexThreadIdentity {
	const state = ensureFallbackSession(piSessionId);
	if (
		compactionEntryId
		&& state.identity.lastCompactionEntryId === compactionEntryId
	) {
		return cloneIdentity(state.identity);
	}
	state.identity.previousWindowId = state.identity.windowId;
	state.identity.windowId = uuidV7();
	state.identity.windowNumber += 1;
	if (compactionEntryId) {
		state.identity.lastCompactionEntryId = compactionEntryId;
	}
	return cloneIdentity(state.identity);
}

export function beginCodexTurn(
	piSessionId: string,
	options: {
		parentPiSessionId?: string;
		turnId?: string;
		startedAtMs?: number;
	} = {},
): CodexTurnIdentity {
	const state = ensureFallbackSession(piSessionId);
	if (state.activeTurn) return structuredClone(state.activeTurn);

	const parentTurn = options.parentPiSessionId
		? runtime().sessions.get(options.parentPiSessionId)?.activeTurn
		: undefined;
	const turnId = isUuidV7(options.turnId) ? options.turnId : uuidV7();
	const turn: CodexTurnIdentity = {
		turnId,
		startedAtMs: options.startedAtMs ?? Date.now(),
		...(parentTurn ? { parentTurnId: parentTurn.turnId } : {}),
		rootTurnId: parentTurn?.rootTurnId ?? parentTurn?.turnId ?? turnId,
		...(state.pendingTurnState
			? { turnState: state.pendingTurnState }
			: {}),
	};
	delete state.pendingTurnState;
	state.activeTurn = turn;
	return structuredClone(turn);
}

export function currentCodexTurn(piSessionId: string | undefined): CodexTurnIdentity | undefined {
	if (!piSessionId) return undefined;
	const turn = runtime().sessions.get(piSessionId)?.activeTurn;
	return turn ? structuredClone(turn) : undefined;
}

export function endCodexTurn(piSessionId: string, turnId?: string): void {
	const state = runtime().sessions.get(piSessionId);
	if (!state?.activeTurn) return;
	if (turnId && state.activeTurn.turnId !== turnId) return;
	delete state.activeTurn;
}

export function codexTurnStateFor(piSessionId: string): string | undefined {
	return runtime().sessions.get(piSessionId)?.activeTurn?.turnState;
}

/** Store the first sticky-routing token for the active logical turn only. */
export function captureCodexTurnState(
	piSessionId: string,
	token: string | undefined,
): void {
	if (typeof token !== "string" || !token.trim()) return;
	const state = ensureFallbackSession(piSessionId);
	if (!state.activeTurn) {
		if (!state.pendingTurnState) state.pendingTurnState = token.trim();
		return;
	}
	if (state.activeTurn.turnState) return;
	state.activeTurn.turnState = token.trim();
}

function metadataString(
	metadata: Record<string, unknown> | undefined,
	key: string,
): string | undefined {
	const value = metadata?.[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Resolve one immutable identity snapshot for an actual provider request.
 * Valid explicit UUID values are consumed directly; they are never used as
 * derivation keys.
 */
export function resolveCodexRequestIdentity(
	piSessionId: string | undefined,
	metadata: Record<string, unknown> | undefined,
	requestKind: CodexRequestIdentity["requestKind"] = "turn",
): CodexRequestIdentity | undefined {
	const explicitSessionId = metadataString(metadata, "session_id");
	const explicitThreadId = metadataString(metadata, "thread_id");
	const explicitWindowId = metadataString(metadata, "window_id")
		?? metadataString(metadata, "x-codex-window-id");
	const state = piSessionId ? ensureFallbackSession(piSessionId) : undefined;
	if (
		!state
		&& (!isUuidV7(explicitSessionId) || !isUuidV7(explicitThreadId))
	) {
		return undefined;
	}
	const identity = state?.identity;
	const sessionId = isUuidV7(explicitSessionId)
		? explicitSessionId
		: identity?.sessionId;
	const threadId = isUuidV7(explicitThreadId)
		? explicitThreadId
		: identity?.threadId;
	const windowId = isUuidV7(explicitWindowId)
		? explicitWindowId
		: identity?.windowId;
	if (!sessionId || !threadId || !windowId) return undefined;

	let turn = state?.activeTurn;
	const explicitTurnId = metadataString(metadata, "turn_id");
	if (isUuidV7(explicitTurnId)) {
		if (!turn || turn.turnId !== explicitTurnId) {
			turn = {
				turnId: explicitTurnId,
				startedAtMs: Date.now(),
				rootTurnId: explicitTurnId,
				...(state?.pendingTurnState
					? { turnState: state.pendingTurnState }
					: {}),
			};
			if (state) {
				state.activeTurn = turn;
				delete state.pendingTurnState;
			}
		}
	} else if (!turn && requestKind !== "prewarm" && piSessionId) {
		turn = beginCodexTurn(piSessionId);
	}

	const explicitParentThreadId = metadataString(metadata, "parent_thread_id");
	const explicitForkedFromThreadId = metadataString(metadata, "forked_from_thread_id");
	const explicitParentTurnId = metadataString(metadata, "parent_turn_id");
	const explicitRootTurnId = metadataString(metadata, "root_turn_id");
	return {
		installationId: codexInstallationIdFor(),
		sessionId,
		threadId,
		windowId,
		turnId: turn?.turnId ?? "",
		...(turn ? { turnStartedAtMs: turn.startedAtMs } : {}),
		requestKind,
		...(isUuidV7(explicitParentThreadId)
			? { parentThreadId: explicitParentThreadId }
			: identity?.parentThreadId
				? { parentThreadId: identity.parentThreadId }
				: {}),
		...(isUuidV7(explicitForkedFromThreadId)
			? { forkedFromThreadId: explicitForkedFromThreadId }
			: identity?.forkedFromThreadId
				? { forkedFromThreadId: identity.forkedFromThreadId }
				: {}),
		...(isUuidV7(explicitParentTurnId)
			? { parentTurnId: explicitParentTurnId }
			: turn?.parentTurnId
				? { parentTurnId: turn.parentTurnId }
				: {}),
		...(isUuidV7(explicitRootTurnId)
			? { rootTurnId: explicitRootTurnId }
			: turn?.rootTurnId
				? { rootTurnId: turn.rootTurnId }
				: {}),
		...(identity?.agentName ? { agentName: identity.agentName } : {}),
		...(identity?.subagentKind ? { subagentKind: identity.subagentKind } : {}),
		...(turn?.turnState ? { turnState: turn.turnState } : {}),
	};
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as UnknownRecord
		: undefined;
}

export function parseCodexThreadIdentity(value: unknown): CodexThreadIdentity {
	const input = asRecord(value);
	if (!input || input.version !== 1) {
		throw new Error("unsupported Codex thread identity version");
	}
	for (const field of [
		"piSessionId",
		"sessionId",
		"threadId",
		"windowId",
		"firstWindowId",
	] as const) {
		if (typeof input[field] !== "string" || !input[field]) {
			throw new Error(`Codex thread identity ${field} must be a non-empty string`);
		}
	}
	for (const field of [
		"sessionId",
		"threadId",
		"windowId",
		"firstWindowId",
		"previousWindowId",
		"parentThreadId",
		"forkedFromThreadId",
	] as const) {
		if (input[field] !== undefined && !isUuidV7(input[field])) {
			throw new Error(`Codex thread identity ${field} must be a UUIDv7`);
		}
	}
	if (
		typeof input.windowNumber !== "number"
		|| !Number.isSafeInteger(input.windowNumber)
		|| input.windowNumber < 0
	) {
		throw new Error("Codex thread identity windowNumber must be a non-negative integer");
	}
	for (const field of [
		"agentName",
		"subagentKind",
		"lastCompactionEntryId",
	] as const) {
		if (input[field] !== undefined && typeof input[field] !== "string") {
			throw new Error(`Codex thread identity ${field} must be a string`);
		}
	}
	return {
		version: 1,
		piSessionId: input.piSessionId as string,
		sessionId: input.sessionId as string,
		threadId: input.threadId as string,
		windowId: input.windowId as string,
		firstWindowId: input.firstWindowId as string,
		windowNumber: input.windowNumber,
		...(input.previousWindowId
			? { previousWindowId: input.previousWindowId as string }
			: {}),
		...(input.parentThreadId
			? { parentThreadId: input.parentThreadId as string }
			: {}),
		...(input.forkedFromThreadId
			? { forkedFromThreadId: input.forkedFromThreadId as string }
			: {}),
		...(input.agentName ? { agentName: input.agentName as string } : {}),
		...(input.subagentKind
			? { subagentKind: input.subagentKind as string }
			: {}),
		...(input.lastCompactionEntryId
			? { lastCompactionEntryId: input.lastCompactionEntryId as string }
			: {}),
	};
}

export function resetCodexWireState(): void {
	const state = runtime();
	state.sessions.clear();
	delete state.installationId;
	delete state.installationPath;
}

export function codexWireIdentityCount(): number {
	return runtime().sessions.size;
}
