import { rm } from "node:fs/promises";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
	ContextInheritance,
	SubagentMode,
	SubagentProviderName,
} from "./types.ts";

const INHERITED_COMPACTION_CUSTOM_TYPE =
	"pi-subagent/inherited-compaction-summary";
const INHERITED_BRANCH_CUSTOM_TYPE =
	"pi-subagent/inherited-branch-summary";
const COMPACTION_SUMMARY_PREFIX =
	"The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const COMPACTION_SUMMARY_SUFFIX = "\n</summary>";
const BRANCH_SUMMARY_PREFIX =
	"The following is a summary of a branch that this conversation came back from:\n\n<summary>\n";
const BRANCH_SUMMARY_SUFFIX = "</summary>";

export interface SessionView {
	getBranch(): SessionEntry[];
	getCwd(): string;
	getSessionDir(): string;
	getSessionFile(): string | undefined;
	getSessionId(): string;
	getEntries(): SessionEntry[];
	buildContextEntries(): SessionEntry[];
	appendCustomEntry(customType: string, data?: unknown): string;
}

export interface ProviderParent {
	sessionManager: SessionView;
}

export interface PreparedChildSession {
	sessionManager: SessionManager;
	seedMessageCount: number;
	rollback(): Promise<void>;
}

export interface ChildProvider {
	name: SubagentProviderName;
	inheritsParentContext: boolean;
	supportsContinuable: boolean;
	prepare(
		parent: ProviderParent,
		mode: SubagentMode,
		context?: ContextInheritance,
	): Promise<PreparedChildSession>;
}

async function removeOwnedSession(path: string | undefined): Promise<void> {
	if (!path) return;
	await rm(path, { force: true });
}

function freshSession(parent: ProviderParent): PreparedChildSession {
	const parentFile = parent.sessionManager.getSessionFile();
	const options = parentFile ? { parentSession: parentFile } : undefined;
	const sessionManager = parentFile
		? SessionManager.create(
				parent.sessionManager.getCwd(),
				parent.sessionManager.getSessionDir(),
				options,
			)
		: SessionManager.inMemory(parent.sessionManager.getCwd(), options);
	const childFile = sessionManager.getSessionFile();
	return {
		sessionManager,
		seedMessageCount: 0,
		rollback: () => removeOwnedSession(childFile),
	};
}

/**
 * Return the latest assistant entry that closed a completed turn.
 *
 * A tool-calling assistant message has stopReason "toolUse" and is not a safe
 * fork boundary. The current parent turn is therefore excluded.
 */
export function completedTurnBoundaryId(entries: readonly SessionEntry[]): string | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		if (entry.message.stopReason !== "toolUse") return entry.id;
	}
	return undefined;
}

interface CompletedTurnSpan {
	start: number;
	end: number;
}

function isSummaryEntry(entry: SessionEntry): boolean {
	return (
		entry.type === "compaction"
		|| entry.type === "branch_summary"
		|| (
			entry.type === "message"
			&& (
				entry.message.role === "compactionSummary"
				|| entry.message.role === "branchSummary"
			)
		)
	);
}

function startsModelTurn(entry: SessionEntry): boolean {
	if (entry.type === "custom_message") return true;
	if (entry.type !== "message") return false;
	switch (entry.message.role) {
		case "user":
		case "custom":
			return true;
		case "bashExecution":
			return !entry.message.excludeFromContext;
		default:
			return false;
	}
}

function completedTurnSpans(
	entries: readonly SessionEntry[],
): {
	turns: CompletedTurnSpan[];
	latestSummary?: number;
} {
	const turns: CompletedTurnSpan[] = [];
	let latestSummary: number | undefined;
	let currentStart: number | undefined;
	let currentEnd: number | undefined;
	const finishCurrent = () => {
		if (currentStart !== undefined && currentEnd !== undefined) {
			turns.push({ start: currentStart, end: currentEnd });
		}
		currentStart = undefined;
		currentEnd = undefined;
	};

	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index]!;
		if (isSummaryEntry(entry)) {
			finishCurrent();
			latestSummary = index;
			continue;
		}
		if (startsModelTurn(entry)) {
			finishCurrent();
			currentStart = index;
			continue;
		}
		if (entry.type !== "message") continue;
		if (
			currentStart === undefined
			&& (
				entry.message.role === "assistant"
				|| entry.message.role === "toolResult"
			)
		) {
			currentStart = latestSummary ?? 0;
		}
		if (
			entry.message.role === "assistant"
			&& entry.message.stopReason !== "toolUse"
		) {
			currentEnd = index;
		}
	}
	finishCurrent();
	return {
		turns,
		...(latestSummary !== undefined ? { latestSummary } : {}),
	};
}

export function completedContextEntries(
	entries: readonly SessionEntry[],
	context: Exclude<ContextInheritance, { mode: "fresh" }>,
): SessionEntry[] {
	const { turns, latestSummary } = completedTurnSpans(entries);
	const end = Math.max(
		turns.at(-1)?.end ?? -1,
		latestSummary ?? -1,
	);
	if (end < 0) return [];
	let start = 0;
	if (context.mode === "last_n_completed") {
		if (turns.length >= context.completedTurns) {
			start = turns[turns.length - context.completedTurns]!.start;
		}
	}
	return entries
		.slice(start, end + 1)
		.map((entry) => structuredClone(entry));
}

function appendInheritedEntry(
	session: SessionManager,
	entry: SessionEntry,
): void {
	if (entry.type === "message") {
		// Children inherit conversation data, not the parent's prompt or executable loadout.
		if (entry.message.role === "system") return;
		if (entry.message.role === "compactionSummary") {
			session.appendCustomMessageEntry(
				INHERITED_COMPACTION_CUSTOM_TYPE,
				`${COMPACTION_SUMMARY_PREFIX}${entry.message.summary}${COMPACTION_SUMMARY_SUFFIX}`,
				false,
				{ tokensBefore: entry.message.tokensBefore },
			);
			return;
		}
		if (entry.message.role === "branchSummary") {
			session.appendCustomMessageEntry(
				INHERITED_BRANCH_CUSTOM_TYPE,
				`${BRANCH_SUMMARY_PREFIX}${entry.message.summary}${BRANCH_SUMMARY_SUFFIX}`,
				false,
				{ fromId: entry.message.fromId },
			);
			return;
		}
		session.appendMessage(
			structuredClone(
				entry.message,
			) as Parameters<SessionManager["appendMessage"]>[0],
		);
		return;
	}
	if (entry.type === "custom_message") {
		session.appendCustomMessageEntry(
			entry.customType,
			structuredClone(entry.content),
			entry.display,
			structuredClone(entry.details),
		);
		return;
	}
	if (entry.type === "compaction") {
		session.appendCustomMessageEntry(
			INHERITED_COMPACTION_CUSTOM_TYPE,
			`${COMPACTION_SUMMARY_PREFIX}${entry.summary}${COMPACTION_SUMMARY_SUFFIX}`,
			false,
			{ tokensBefore: entry.tokensBefore },
		);
		return;
	}
	if (entry.type === "branch_summary") {
		session.appendCustomMessageEntry(
			INHERITED_BRANCH_CUSTOM_TYPE,
			`${BRANCH_SUMMARY_PREFIX}${entry.summary}${BRANCH_SUMMARY_SUFFIX}`,
			false,
			{ fromId: entry.fromId },
		);
	}
}

function forkedSession(
	parent: ProviderParent,
	context: Exclude<ContextInheritance, { mode: "fresh" }>,
): PreparedChildSession {
	const parentFile = parent.sessionManager.getSessionFile();
	const inherited = completedContextEntries(
		parent.sessionManager.buildContextEntries(),
		context,
	);
	if (inherited.length === 0) return freshSession(parent);
	if (!parentFile) {
		throw new Error(
			"fork provider cannot copy completed history from an ephemeral parent session; use spawn instead",
		);
	}
	const prepared = freshSession(parent);
	for (const entry of inherited) {
		appendInheritedEntry(prepared.sessionManager, entry);
	}
	return {
		...prepared,
		seedMessageCount:
			prepared.sessionManager.buildSessionContext().messages.length,
	};
}

export class SpawnProvider implements ChildProvider {
	readonly name = "spawn";
	readonly inheritsParentContext = false;
	readonly supportsContinuable = true;

	prepare(
		parent: ProviderParent,
		_mode: SubagentMode,
		context: ContextInheritance = { mode: "fresh" },
	): Promise<PreparedChildSession> {
		if (context.mode !== "fresh") {
			throw new Error("spawn provider requires fresh context");
		}
		return Promise.resolve(freshSession(parent));
	}
}

export class ForkProvider implements ChildProvider {
	readonly name = "fork";
	readonly inheritsParentContext = true;
	readonly supportsContinuable = true;

	async prepare(
		parent: ProviderParent,
		_mode: SubagentMode,
		context: ContextInheritance = { mode: "all_completed" },
	): Promise<PreparedChildSession> {
		if (context.mode === "fresh") {
			throw new Error("fork provider requires inherited context");
		}
		return forkedSession(parent, context);
	}
}

export class ProviderRegistry {
	private readonly providers = new Map<SubagentProviderName, ChildProvider>();

	register(provider: ChildProvider): void {
		if (this.providers.has(provider.name)) throw new Error(`duplicate subagent provider: ${provider.name}`);
		this.providers.set(provider.name, provider);
	}

	get(name: SubagentProviderName): ChildProvider {
		const provider = this.providers.get(name);
		if (!provider) throw new Error(`subagent provider is not registered: ${name}`);
		return provider;
	}

	list(): ChildProvider[] {
		return [...this.providers.values()];
	}
}
