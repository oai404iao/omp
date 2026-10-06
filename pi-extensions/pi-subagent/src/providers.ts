import { closeSync, existsSync, fsyncSync, openSync, writeFileSync } from "node:fs";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildSessionProjection, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ForkTurns } from "./types.ts";

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
): SessionEntry[] {
	const { turns, latestSummary } = completedTurnSpans(entries);
	const end = Math.max(
		turns.at(-1)?.end ?? -1,
		latestSummary ?? -1,
	);
	if (end < 0) return [];
	return entries
		.slice(0, end + 1)
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

export function prepareChildSession(
	parent: SessionView,
	sessionDir: string,
	forkTurns: ForkTurns,
): SessionManager {
	const parentFile = parent.getSessionFile();
	if (!parentFile) throw new Error("spawn_agent requires a persisted parent session");
	const session = SessionManager.create(parent.getCwd(), sessionDir, { parentSession: parentFile });
	if (forkTurns === "none") return session;
	const inherited = completedContextEntries(
		buildSessionProjection(parent.getBranch()).entries.flatMap(
			({ sourceEntry, messages }) => messages.map((message): SessionEntry => ({
				type: "message",
				id: sourceEntry.id,
				parentId: sourceEntry.parentId,
				timestamp: sourceEntry.timestamp,
				message,
			})),
		),
	);
	for (const entry of inherited) {
		appendInheritedEntry(session, entry);
	}
	return session;
}

/**
 * Pi normally defers setup-only JSONL writes. Materialize the documented file
 * format before publishing an agent, then reopen it so Pi owns future writes.
 * No SDK private fields or fabricated conversation messages are used.
 */
export function persistPreparedSession(session: SessionManager): SessionManager {
	const path = session.getSessionFile();
	if (!path) throw new Error("child session must be persistent");
	if (!existsSync(path)) {
		const fd = openSync(path, "wx", 0o600);
		try {
			writeFileSync(fd, [session.getHeader(), ...session.getEntries()].map(e => JSON.stringify(e)).join("\n") + "\n");
			fsyncSync(fd);
		} finally { closeSync(fd); }
	} else {
		const fd = openSync(path, "r");
		try { fsyncSync(fd); } finally { closeSync(fd); }
	}
	return SessionManager.open(path);
}
