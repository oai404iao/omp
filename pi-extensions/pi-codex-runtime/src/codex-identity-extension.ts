import { claimSessionFeature } from "./session-claims.js";
import { installFastModeLifecycle } from "./fast-mode-state.js";
import { readSubagentLineage, type SubagentLineage } from "./codex-session-lineage.js";
import { installCodexTurnLifecycle } from "./codex-turn-lifecycle.js";
import {
	SessionManager,
	type ExtensionAPI,
	type InlineExtension,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	advanceCodexWindow,
	codexThreadIdentityFor,
	createCodexChildIdentity,
	createCodexRootIdentity,
	parseCodexThreadIdentity,
	registerCodexThreadIdentity,
	type CodexThreadIdentity,
} from "./codex-wire-identity.js";

export const CODEX_IDENTITY_CUSTOM_TYPE = "pi-codex/thread-identity";
const IDENTITY_LIFECYCLE_SYMBOL = Symbol.for(
	"@oai404iao/pi-codex/identity-lifecycle/v1",
);
const resolvingParents = new Set<string>();

export interface CodexIdentitySessionView {
	getSessionId(): string;
	getSessionFile(): string | undefined;
	getSessionDir(): string;
	getCwd(): string;
	getEntries(): SessionEntry[];
	getBranch?(): SessionEntry[];
	appendCustomEntry?(customType: string, data?: unknown): string;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function readIdentity(
	entries: readonly SessionEntry[],
	piSessionId?: string,
): CodexThreadIdentity | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (
			entry?.type !== "custom"
			|| entry.customType !== CODEX_IDENTITY_CUSTOM_TYPE
		) {
			continue;
		}
		try {
			const identity = parseCodexThreadIdentity(entry.data);
			if (!piSessionId || identity.piSessionId === piSessionId) {
				return identity;
			}
		} catch {
			// A newer valid entry can repair a corrupt historical checkpoint.
		}
	}
	return undefined;
}

function appendIdentity(
	session: CodexIdentitySessionView,
	identity: CodexThreadIdentity,
	appendCurrent?: (identity: CodexThreadIdentity) => void,
): void {
	if (appendCurrent) {
		appendCurrent(identity);
		return;
	}
	session.appendCustomEntry?.(
		CODEX_IDENTITY_CUSTOM_TYPE,
		structuredClone(identity),
	);
}

function openParentSession(
	session: CodexIdentitySessionView,
	lineage: SubagentLineage,
): CodexIdentitySessionView | undefined {
	if (!lineage.parentSessionFile) return undefined;
	try {
		return SessionManager.open(
			lineage.parentSessionFile,
			session.getSessionDir(),
			session.getCwd(),
		);
	} catch {
		return undefined;
	}
}

function resolveParentIdentity(
	session: CodexIdentitySessionView,
	lineage: SubagentLineage,
): CodexThreadIdentity {
	const active = codexThreadIdentityFor(lineage.parentPiSessionId);
	if (active) return active;

	const parent = openParentSession(session, lineage);
	if (parent && parent.getSessionId() === lineage.parentPiSessionId) {
		if (resolvingParents.has(lineage.parentPiSessionId)) throw new Error("Cyclic Codex subagent lineage");
		resolvingParents.add(lineage.parentPiSessionId);
		try { return ensureCodexSessionIdentity(parent); }
		finally { resolvingParents.delete(lineage.parentPiSessionId); }
	}

	// Ephemeral parents have no file to reopen. They are still represented by a
	// process-local root identity for the lifetime of the child tree.
	const root = createCodexRootIdentity(lineage.parentPiSessionId);
	return registerCodexThreadIdentity(root);
}

export function ensureCodexSessionIdentity(
	session: CodexIdentitySessionView,
	options: {
		sessionStartReason?: string;
		appendCurrent?: (identity: CodexThreadIdentity) => void;
	} = {},
): CodexThreadIdentity {
	const piSessionId = session.getSessionId();
	const branch = session.getBranch?.() ?? session.getEntries();
	const persisted = readIdentity(branch, piSessionId);
	const lineage = readSubagentLineage(session.getEntries());
	if (persisted) {
		if (lineage && (!persisted.parentThreadId || codexThreadIdentityFor(lineage.parentPiSessionId))) {
			const parent = resolveParentIdentity(session, lineage);
			persisted.sessionId = parent.sessionId;
			persisted.parentThreadId = parent.threadId;
			if (lineage.relation === "fork") persisted.forkedFromThreadId = parent.threadId;
			persisted.subagentKind = "thread_spawn";
			persisted.subagentHeader = "collab_spawn";
		}
		if (lineage?.agentName) persisted.agentName = lineage.agentName;
		const stored = [...branch].reverse().find(entry =>
			entry.type === "custom" && entry.customType === CODEX_IDENTITY_CUSTOM_TYPE
			&& record(entry.data)?.piSessionId === piSessionId);
		const raw = stored?.type === "custom" ? record(stored.data) : undefined;
		if (raw?.windowId !== persisted.windowId || raw?.contextWindowId !== persisted.contextWindowId
			|| raw?.agentName !== persisted.agentName || raw?.subagentKind !== persisted.subagentKind
			|| raw?.sessionId !== persisted.sessionId || raw?.parentThreadId !== persisted.parentThreadId) {
			appendIdentity(session, persisted, options.appendCurrent);
		}
		return registerCodexThreadIdentity(persisted);
	}
	let identity: CodexThreadIdentity;
	if (lineage) {
		identity = createCodexChildIdentity(
			piSessionId,
			resolveParentIdentity(session, lineage),
			{
				relation: lineage.relation,
				agentName: lineage.agentName,
			},
		);
	} else {
		const copied = readIdentity(branch);
		identity = createCodexRootIdentity(piSessionId, {
			...(options.sessionStartReason === "fork" && copied
				? { forkedFromThreadId: copied.threadId }
				: {}),
		});
	}

	appendIdentity(session, identity, options.appendCurrent);
	return registerCodexThreadIdentity(identity);
}

/**
 * Install only the session/turn/window lifecycle needed by the Codex provider.
 * It deliberately does not register providers, tools, commands, or renderers.
 */
export function installCodexIdentityLifecycle(pi: ExtensionAPI): void {
	const guard = pi as unknown as Record<PropertyKey, unknown>;
	if (guard[IDENTITY_LIFECYCLE_SYMBOL]) return;
	if (!claimSessionFeature(pi, "wire-identity")) return;
	guard[IDENTITY_LIFECYCLE_SYMBOL] = true;

	const ensure = (
		ctx: {
			sessionManager?: Partial<CodexIdentitySessionView>;
		},
		sessionStartReason?: string,
	): CodexThreadIdentity | undefined => {
		const session = ctx.sessionManager;
		if (!session || typeof session.getSessionId !== "function") {
			return undefined;
		}
		const piSessionId = session.getSessionId();
		if (typeof session.getEntries !== "function") {
			const existing = codexThreadIdentityFor(piSessionId);
			if (existing) return existing;
			return registerCodexThreadIdentity(
				createCodexRootIdentity(piSessionId),
			);
		}
		return ensureCodexSessionIdentity(session as CodexIdentitySessionView, {
			sessionStartReason,
			appendCurrent: (identity) => {
				pi.appendEntry(
					CODEX_IDENTITY_CUSTOM_TYPE,
					structuredClone(identity),
				);
			},
		});
	};

	pi.on("session_start", async (event, ctx) => {
		ensure(ctx as unknown as { sessionManager: CodexIdentitySessionView }, event.reason);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		const typed = ctx as unknown as { sessionManager: CodexIdentitySessionView };
		ensure(typed);
	});

	pi.on("session_compact", async (event, ctx) => {
		const typed = ctx as unknown as { sessionManager: CodexIdentitySessionView };
		if (!ensure(typed)) return;
		const identity = advanceCodexWindow(
			typed.sessionManager.getSessionId(),
			event.compactionEntry.id,
		);
		pi.appendEntry(
			CODEX_IDENTITY_CUSTOM_TYPE,
			structuredClone(identity),
		);
	});

	pi.on("session_tree", async (_event, ctx) => {
		const typed = ctx as unknown as { sessionManager: CodexIdentitySessionView };
		ensure(typed);
	});

	installCodexTurnLifecycle(pi);
}

/** Session identity and Fast inheritance, including when normal extension inheritance is off. */
export function createCodexSubagentInlineExtension(
	options: { parentSessionManager?: CodexIdentitySessionView; openAIIdentity?: boolean } = {},
): InlineExtension {
	if (options.parentSessionManager && options.openAIIdentity !== false) {
		ensureCodexSessionIdentity(options.parentSessionManager);
	}
	return {
		name: "pi-codex-subagent-identity",
		factory: (pi) => {
			installFastModeLifecycle(pi, options.parentSessionManager);
			if (options.openAIIdentity !== false) installCodexIdentityLifecycle(pi);
			else installCodexTurnLifecycle(pi);
		},
	};
}
