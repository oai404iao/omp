import {
	SessionManager,
	type ExtensionAPI,
	type InlineExtension,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	advanceCodexWindow,
	beginCodexTurn,
	codexThreadIdentityFor,
	createCodexChildIdentity,
	createCodexRootIdentity,
	endCodexTurn,
	parseCodexThreadIdentity,
	registerCodexThreadIdentity,
	type CodexThreadIdentity,
} from "./codex-wire-identity.js";

export const CODEX_IDENTITY_CUSTOM_TYPE = "pi-codex/thread-identity";
const SUBAGENT_DESCRIPTOR_CUSTOM_TYPE = "pi-subagent/descriptor";
const SUBAGENT_LINEAGE_CUSTOM_TYPE = "pi-subagent/lineage";
const IDENTITY_LIFECYCLE_SYMBOL = Symbol.for(
	"@oai404iao/pi-codex/identity-lifecycle/v1",
);

export interface CodexIdentitySessionView {
	getSessionId(): string;
	getSessionFile(): string | undefined;
	getSessionDir(): string;
	getCwd(): string;
	getEntries(): SessionEntry[];
	getBranch?(): SessionEntry[];
	appendCustomEntry?(customType: string, data?: unknown): string;
}

interface SubagentLineage {
	agentId: string;
	parentAgentId: string;
	parentPiSessionId: string;
	parentSessionFile?: string;
	relation: "spawn" | "fork";
	agentName?: string;
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

function readSubagentLineage(
	entries: readonly SessionEntry[],
): SubagentLineage | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (
			entry?.type === "custom"
			&& entry.customType === SUBAGENT_LINEAGE_CUSTOM_TYPE
		) {
			const lineage = record(entry.data);
			if (
				lineage?.version !== 1
				|| lineage.openAIIdentity !== true
				|| (lineage.relation !== "spawn" && lineage.relation !== "fork")
				|| typeof lineage.agentId !== "string"
				|| typeof lineage.parentAgentId !== "string"
				|| typeof lineage.parentPiSessionId !== "string"
			) {
				return undefined;
			}
			return {
				agentId: lineage.agentId,
				parentAgentId: lineage.parentAgentId,
				parentPiSessionId: lineage.parentPiSessionId,
				relation: lineage.relation,
				...(typeof lineage.parentSessionFile === "string"
					? { parentSessionFile: lineage.parentSessionFile }
					: {}),
				...(typeof lineage.agentName === "string"
					? { agentName: lineage.agentName }
					: {}),
			};
		}
		if (
			entry?.type !== "custom"
			|| entry.customType !== SUBAGENT_DESCRIPTOR_CUSTOM_TYPE
		) {
			continue;
		}
		const descriptor = record(entry.data);
		const runtime = record(descriptor?.runtime);
		if (
			descriptor?.version !== 2
			|| runtime?.openAIIdentity !== true
			|| (descriptor.provider !== "spawn" && descriptor.provider !== "fork")
			|| typeof descriptor.agentId !== "string"
			|| typeof descriptor.parentAgentId !== "string"
			|| typeof descriptor.parentPiSessionId !== "string"
		) {
			return undefined;
		}
		const agent = record(descriptor.agent);
		return {
			agentId: descriptor.agentId,
			parentAgentId: descriptor.parentAgentId,
			parentPiSessionId: descriptor.parentPiSessionId,
			relation: descriptor.provider,
			...(typeof descriptor.parentSessionFile === "string"
				? { parentSessionFile: descriptor.parentSessionFile }
				: {}),
			...(typeof agent?.name === "string" ? { agentName: agent.name } : {}),
		};
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
	if (parent) {
		const persisted = readIdentity(
			parent.getEntries(),
			lineage.parentPiSessionId,
		);
		if (persisted) return registerCodexThreadIdentity(persisted);

		// pi-codex-minimal-tools owns the Codex identity even when the parent
		// happened to use a non-Codex model before creating this OpenAI child.
		const root = createCodexRootIdentity(lineage.parentPiSessionId);
		appendIdentity(parent, root);
		return registerCodexThreadIdentity(root);
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
	const persisted = readIdentity(session.getEntries(), piSessionId);
	if (persisted) return registerCodexThreadIdentity(persisted);

	const lineage = readSubagentLineage(session.getEntries());
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
		const copied = readIdentity(session.getEntries());
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
		const identity = ensure(typed);
		if (!identity) return;
		const lineage =
			typeof typed.sessionManager.getEntries === "function"
				? readSubagentLineage(typed.sessionManager.getEntries())
				: undefined;
		beginCodexTurn(identity.piSessionId, {
			...(lineage?.parentPiSessionId
				? { parentPiSessionId: lineage.parentPiSessionId }
				: {}),
		});
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const piSessionId = ctx.sessionManager?.getSessionId?.();
		if (piSessionId) endCodexTurn(piSessionId);
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
		const piSessionId = typed.sessionManager.getSessionId();
		const branch = typed.sessionManager.getBranch?.()
			?? typed.sessionManager.getEntries();
		const identity = readIdentity(branch, piSessionId)
			?? readIdentity(typed.sessionManager.getEntries(), piSessionId);
		if (identity) registerCodexThreadIdentity(identity);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const piSessionId = ctx.sessionManager?.getSessionId?.();
		if (piSessionId) endCodexTurn(piSessionId);
	});
}

/** Named inline extension used by pi-subagent when normal inheritance is off. */
export function createCodexSubagentInlineExtension(
	options: { parentSessionManager?: CodexIdentitySessionView } = {},
): InlineExtension {
	if (options.parentSessionManager) {
		ensureCodexSessionIdentity(options.parentSessionManager);
	}
	return {
		name: "pi-codex-subagent-identity",
		factory: (pi) => {
			installCodexIdentityLifecycle(pi);
		},
	};
}
