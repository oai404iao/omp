import { uuidv7 } from "@earendil-works/pi-ai";

export interface CodexThreadIdentity {
	version: 1;
	piSessionId: string;
	sessionId: string;
	threadId: string;
	windowId: string;
	contextWindowId: string;
	// These persisted v1 fields retain context UUIDs, not thread:number wire IDs.
	firstWindowId: string;
	previousWindowId?: string;
	windowNumber: number;
	parentThreadId?: string;
	forkedFromThreadId?: string;
	agentName?: string;
	subagentKind?: string;
	subagentHeader?: string;
	lastCompactionEntryId?: string;
}

export interface CodexWireIdentity {
	sessionId: string;
	threadId: string;
	windowId: string;
	windowNumber: number;
	contextWindowId: string;
}

export interface CodexTurnAttribution {
	parentTurnId?: string;
	rootTurnId?: string;
}

export interface CodexTurnIdentity extends CodexTurnAttribution {
	turnId: string;
	startedAtMs: number;
	turnState?: string;
}

export interface CodexCompactionMetadata {
	trigger: string;
	reason: string;
	implementation: string;
	phase: string;
	strategy: string;
}

export interface CodexRequestIdentity extends CodexWireIdentity, CodexTurnAttribution {
	installationId: string;
	turnId: string;
	turnStartedAtMs?: number;
	requestKind: "turn" | "compaction" | "prewarm";
	parentThreadId?: string;
	forkedFromThreadId?: string;
	agentName?: string;
	subagentKind?: string;
	subagentHeader?: string;
	turnState?: string;
	model?: string;
	reasoningEffort?: string;
	compaction?: CodexCompactionMetadata;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function uuidV7(): string { return uuidv7(); }
export function isUuid(value: unknown): value is string { return typeof value === "string" && UUID_PATTERN.test(value); }
export function isUuidV7(value: unknown): value is string { return typeof value === "string" && UUID_V7_PATTERN.test(value); }
export function canonicalAgentName(name: string | undefined): string {
	return !name || name === "root" ? "/root" : name.startsWith("/") ? name : `/root/${name}`;
}

export function parseCodexThreadIdentity(value: unknown): CodexThreadIdentity {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("unsupported Codex thread identity version");
	const input = value as Record<string, unknown>;
	if (input.version !== 1) throw new Error("unsupported Codex thread identity version");
	if (typeof input.piSessionId !== "string" || !input.piSessionId) throw new Error("Codex thread identity piSessionId must be a non-empty string");
	for (const field of ["sessionId", "threadId", "firstWindowId", "previousWindowId", "parentThreadId", "forkedFromThreadId"] as const) {
		if ((input[field] !== undefined || ["sessionId", "threadId", "firstWindowId"].includes(field)) && !isUuidV7(input[field])) {
			throw new Error(`Codex thread identity ${field} must be a UUIDv7`);
		}
	}
	if (typeof input.windowNumber !== "number" || !Number.isSafeInteger(input.windowNumber) || input.windowNumber < 0) {
		throw new Error("Codex thread identity windowNumber must be a non-negative integer");
	}
	const windowId = `${input.threadId}:${input.windowNumber}`;
	const contextWindowId = input.contextWindowId ?? (isUuidV7(input.windowId) ? input.windowId : undefined);
	if (!isUuidV7(contextWindowId)) throw new Error("Codex thread identity contextWindowId must be a UUIDv7");
	if (input.windowId !== windowId && !isUuidV7(input.windowId)) throw new Error("Codex thread identity windowId must match threadId:windowNumber");
	for (const field of ["agentName", "subagentKind", "subagentHeader", "lastCompactionEntryId"] as const) {
		if (input[field] !== undefined && typeof input[field] !== "string") throw new Error(`Codex thread identity ${field} must be a string`);
	}
	const subagentKind = input.subagentKind === "collab_spawn" ? "thread_spawn" : input.subagentKind as string | undefined;
	return {
		version: 1, piSessionId: input.piSessionId,
		sessionId: input.sessionId as string, threadId: input.threadId as string,
		windowId, contextWindowId, windowNumber: input.windowNumber,
		firstWindowId: input.firstWindowId as string,
		...(input.previousWindowId ? { previousWindowId: input.previousWindowId as string } : {}),
		...(input.parentThreadId ? { parentThreadId: input.parentThreadId as string } : {}),
		...(input.forkedFromThreadId ? { forkedFromThreadId: input.forkedFromThreadId as string } : {}),
		agentName: canonicalAgentName(input.agentName as string | undefined),
		...(subagentKind ? { subagentKind, subagentHeader: (input.subagentHeader as string | undefined) ?? (subagentKind === "thread_spawn" ? "collab_spawn" : subagentKind) } : {}),
		...(input.lastCompactionEntryId ? { lastCompactionEntryId: input.lastCompactionEntryId as string } : {}),
	};
}
