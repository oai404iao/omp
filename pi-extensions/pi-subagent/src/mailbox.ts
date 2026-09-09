import { createHash } from "node:crypto";
import { uuidv7 } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SessionView } from "./providers.ts";

export const MAILBOX_MESSAGE_CUSTOM_TYPE = "pi-subagent/mailbox-message";
export const MAILBOX_CLAIM_CUSTOM_TYPE = "pi-subagent/mailbox-claim";
export const MAILBOX_COMMIT_CUSTOM_TYPE = "pi-subagent/mailbox-commit";
export const MAILBOX_VERSION = 1;
export const MAX_MAILBOX_MESSAGE_CHARS = 128 * 1024;
export const MAX_PENDING_MAILBOX_MESSAGES = 256;
export const MAX_PENDING_MAILBOX_BYTES = 256 * 1024;

const UUID_V7_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface MailboxMessage {
	version: 1;
	messageId: string;
	senderAgentId: string;
	recipientAgentId: string;
	content: string;
	createdAt: string;
}

export interface MailboxClaim {
	version: 1;
	turnId: string;
	messageIds: string[];
	claimedAt: string;
}

export interface MailboxCommit {
	version: 1;
	turnId: string;
	userMessageDigest: string;
	committedAt: string;
}

export interface MailboxSnapshot {
	pending: MailboxMessage[];
	claimedMessageIds: Set<string>;
}

export interface MailboxOwner {
	parentAgentId: string;
	agentId: string;
}

export type MailboxFold =
	| { kind: "valid"; snapshot: MailboxSnapshot }
	| { kind: "corrupt"; message: string };

type UnknownRecord = Record<string, unknown>;

function record(value: unknown, field: string): UnknownRecord {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${field} must be an object`);
	}
	return value as UnknownRecord;
}

function uuid(value: unknown, field: string): string {
	if (typeof value !== "string" || !UUID_V7_PATTERN.test(value)) {
		throw new Error(`${field} must be a UUIDv7 id`);
	}
	return value;
}

function isoDate(value: unknown, field: string): string {
	if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
		throw new Error(`${field} must be an ISO date string`);
	}
	return value;
}

function parseMessage(value: unknown): MailboxMessage {
	const input = record(value, "mailbox message");
	if (input.version !== MAILBOX_VERSION) {
		throw new Error(`unsupported mailbox message version: ${String(input.version)}`);
	}
	if (
		typeof input.content !== "string"
		|| input.content.trim().length === 0
		|| input.content.length > MAX_MAILBOX_MESSAGE_CHARS
	) {
		throw new Error(
			`mailbox message content must be non-empty and at most ${MAX_MAILBOX_MESSAGE_CHARS} characters`,
		);
	}
	return {
		version: MAILBOX_VERSION,
		messageId: uuid(input.messageId, "mailbox message.messageId"),
		senderAgentId: uuid(input.senderAgentId, "mailbox message.senderAgentId"),
		recipientAgentId: uuid(input.recipientAgentId, "mailbox message.recipientAgentId"),
		content: input.content,
		createdAt: isoDate(input.createdAt, "mailbox message.createdAt"),
	};
}

function parseClaim(value: unknown): MailboxClaim {
	const input = record(value, "mailbox claim");
	if (input.version !== MAILBOX_VERSION) {
		throw new Error(`unsupported mailbox claim version: ${String(input.version)}`);
	}
	if (
		!Array.isArray(input.messageIds)
		|| input.messageIds.length === 0
	) {
		throw new Error("mailbox claim.messageIds must be a non-empty array");
	}
	const messageIds = input.messageIds.map((value, index) =>
		uuid(value, `mailbox claim.messageIds[${index}]`),
	);
	if (new Set(messageIds).size !== messageIds.length) {
		throw new Error("mailbox claim.messageIds contains a duplicate id");
	}
	return {
		version: MAILBOX_VERSION,
		turnId: uuid(input.turnId, "mailbox claim.turnId"),
		messageIds,
		claimedAt: isoDate(input.claimedAt, "mailbox claim.claimedAt"),
	};
}

function parseCommit(value: unknown): MailboxCommit {
	const input = record(value, "mailbox commit");
	if (input.version !== MAILBOX_VERSION) {
		throw new Error(`unsupported mailbox commit version: ${String(input.version)}`);
	}
	return {
		version: MAILBOX_VERSION,
		turnId: uuid(input.turnId, "mailbox commit.turnId"),
		userMessageDigest:
			typeof input.userMessageDigest === "string"
				&& /^[0-9a-f]{64}$/i.test(input.userMessageDigest)
				? input.userMessageDigest.toLowerCase()
				: (() => {
						throw new Error(
							"mailbox commit.userMessageDigest must be a SHA-256 digest",
						);
					})(),
		committedAt: isoDate(input.committedAt, "mailbox commit.committedAt"),
	};
}

function userMessageDigest(message: unknown): string | undefined {
	if (
		message === null
		|| typeof message !== "object"
		|| (message as { role?: unknown }).role !== "user"
	) {
		return undefined;
	}
	const input = message as { content?: unknown; timestamp?: unknown };
	return createHash("sha256")
		.update(
			JSON.stringify({
				content: input.content,
				timestamp: input.timestamp,
			}),
		)
		.digest("hex");
}

function messageTurnId(entry: SessionEntry): string | undefined {
	if (entry.type !== "message" || entry.message.role !== "user") return undefined;
	const content = entry.message.content as unknown;
	const parts = Array.isArray(content) ? content : [];
	const text = parts
		.filter(
			(part): part is { type: "text"; text: string } =>
				part !== null
				&& typeof part === "object"
				&& (part as { type?: unknown }).type === "text"
				&& typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("");
	const match = /^\[\[pi-subagent-mailbox-turn:([0-9a-f-]+)\]\](?:\n|$)/i.exec(text);
	if (!match || !UUID_V7_PATTERN.test(match[1]!)) return undefined;
	return match[1];
}

function foldMailboxOrThrow(
	entries: readonly SessionEntry[],
	owner?: MailboxOwner,
): MailboxSnapshot {
	const pending: MailboxMessage[] = [];
	const seenMessageIds = new Set<string>();
	const claimedMessageIds = new Set<string>();
	const promptIndexes = new Map<string, number>();
	const commits = new Map<string, Array<{ index: number; digest: string }>>();
	const userMessageIndexes = new Map<string, number[]>();
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index]!;
		const turnId = messageTurnId(entry);
		if (turnId !== undefined && !promptIndexes.has(turnId)) {
			promptIndexes.set(turnId, index);
		}
		if (
			entry.type === "custom"
			&& entry.customType === MAILBOX_COMMIT_CUSTOM_TYPE
		) {
			const commit = parseCommit(entry.data);
			const existing = commits.get(commit.turnId) ?? [];
			existing.push({ index, digest: commit.userMessageDigest });
			commits.set(commit.turnId, existing);
		}
		if (entry.type === "message" && entry.message.role === "user") {
			const digest = userMessageDigest(entry.message);
			if (digest) {
				const existing = userMessageIndexes.get(digest) ?? [];
				existing.push(index);
				userMessageIndexes.set(digest, existing);
			}
		}
	}
	for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
		const entry = entries[entryIndex]!;
		if (entry.type !== "custom") continue;
		if (entry.customType === MAILBOX_MESSAGE_CUSTOM_TYPE) {
			const message = parseMessage(entry.data);
			if (
				owner
				&& (
					message.senderAgentId !== owner.parentAgentId
					|| message.recipientAgentId !== owner.agentId
				)
			) {
				throw new Error(
					`mailbox message ${message.messageId} does not match its descriptor owner`,
				);
			}
			if (seenMessageIds.has(message.messageId)) {
				throw new Error(`duplicate mailbox message id: ${message.messageId}`);
			}
			seenMessageIds.add(message.messageId);
			pending.push(message);
			continue;
		}
		if (entry.customType !== MAILBOX_CLAIM_CUSTOM_TYPE) continue;
		const claim = parseClaim(entry.data);
		if (claim.messageIds.some((messageId) => !seenMessageIds.has(messageId))) {
			throw new Error(`mailbox claim ${claim.turnId} references unavailable messages`);
		}
		const promptIndex = promptIndexes.get(claim.turnId);
		const hasDurableCommit = (commits.get(claim.turnId) ?? []).some(
			(commit) =>
				commit.index > entryIndex
				&& (userMessageIndexes.get(commit.digest) ?? []).some(
					(userIndex) => userIndex > commit.index,
				),
		);
		if (
			(promptIndex === undefined || promptIndex <= entryIndex)
			&& !hasDurableCommit
		) {
			// A crash or prompt rejection can leave a claim record without the
			// corresponding durable user turn. Such reservations remain pending.
			continue;
		}
		if (claim.messageIds.length > pending.length) {
			throw new Error(`mailbox claim ${claim.turnId} references unavailable messages`);
		}
		for (let index = 0; index < claim.messageIds.length; index++) {
			const messageId = claim.messageIds[index]!;
			const expected = pending[index]?.messageId;
			if (messageId !== expected) {
				throw new Error(
					`mailbox claim ${claim.turnId} is not the current FIFO prefix at index ${index}`,
				);
			}
			if (claimedMessageIds.has(messageId)) {
				throw new Error(`mailbox message ${messageId} was claimed more than once`);
			}
			claimedMessageIds.add(messageId);
		}
		pending.splice(0, claim.messageIds.length);
	}
	return {
		pending: pending.map((message) => ({ ...message })),
		claimedMessageIds,
	};
}

export function foldMailbox(entries: readonly SessionEntry[]): MailboxFold {
	try {
		return { kind: "valid", snapshot: foldMailboxOrThrow(entries) };
	} catch (error) {
		return {
			kind: "corrupt",
			message: error instanceof Error ? error.message : String(error),
		};
	}
}

export function foldOwnedMailbox(
	entries: readonly SessionEntry[],
	owner: MailboxOwner,
): MailboxFold {
	try {
		return {
			kind: "valid",
			snapshot: foldMailboxOrThrow(entries, owner),
		};
	} catch (error) {
		return {
			kind: "corrupt",
			message: error instanceof Error ? error.message : String(error),
		};
	}
}

export function readMailbox(
	entries: readonly SessionEntry[],
	owner?: MailboxOwner,
): MailboxSnapshot {
	const folded = owner
		? foldOwnedMailbox(entries, owner)
		: foldMailbox(entries);
	if (folded.kind === "corrupt") {
		throw new Error(`corrupt subagent mailbox: ${folded.message}`);
	}
	return folded.snapshot;
}

export function enqueueMailboxMessage(
	session: SessionView,
	input: {
		senderAgentId: string;
		recipientAgentId: string;
		content: string;
	},
): { message: MailboxMessage; pendingMessages: number } {
	const owner = {
		parentAgentId: input.senderAgentId,
		agentId: input.recipientAgentId,
	};
	const snapshot = readMailbox(session.getEntries(), owner);
	const message = parseMessage({
		version: MAILBOX_VERSION,
		messageId: uuidv7(),
		senderAgentId: input.senderAgentId,
		recipientAgentId: input.recipientAgentId,
		content: input.content,
		createdAt: new Date().toISOString(),
	});
	if (snapshot.pending.length >= MAX_PENDING_MAILBOX_MESSAGES) {
		throw new Error(
			`subagent mailbox already contains ${MAX_PENDING_MAILBOX_MESSAGES} pending messages`,
		);
	}
	const pendingBytes = snapshot.pending.reduce(
		(total, pending) => total + Buffer.byteLength(pending.content, "utf8"),
		0,
	);
	if (
		pendingBytes + Buffer.byteLength(message.content, "utf8")
			> MAX_PENDING_MAILBOX_BYTES
	) {
		throw new Error(
			`subagent mailbox pending content exceeds ${MAX_PENDING_MAILBOX_BYTES} bytes`,
		);
	}
	session.appendCustomEntry(MAILBOX_MESSAGE_CUSTOM_TYPE, message);
	return {
		message,
		pendingMessages: snapshot.pending.length + 1,
	};
}

export function claimMailboxMessages(
	session: SessionView,
	messageIds: readonly string[],
	turnId: string,
	owner?: MailboxOwner,
): MailboxMessage[] {
	const snapshot = readMailbox(session.getEntries(), owner);
	if (messageIds.length === 0) throw new Error("cannot claim an empty mailbox batch");
	if (messageIds.length > snapshot.pending.length) {
		throw new Error("mailbox batch is no longer pending");
	}
	for (let index = 0; index < messageIds.length; index++) {
		if (messageIds[index] !== snapshot.pending[index]?.messageId) {
			throw new Error("mailbox batch is no longer the current FIFO prefix");
		}
	}
	const claim = parseClaim({
		version: MAILBOX_VERSION,
		turnId,
		messageIds: [...messageIds],
		claimedAt: new Date().toISOString(),
	});
	session.appendCustomEntry(MAILBOX_CLAIM_CUSTOM_TYPE, claim);
	return snapshot.pending
		.slice(0, messageIds.length)
		.map((message) => ({ ...message }));
}

export function commitMailboxClaim(
	session: SessionView,
	turnId: string,
	userMessage: unknown,
): void {
	uuid(turnId, "mailbox commit.turnId");
	const hasClaim = session.getEntries().some((entry) => {
		if (
			entry.type !== "custom"
			|| entry.customType !== MAILBOX_CLAIM_CUSTOM_TYPE
		) {
			return false;
		}
		return parseClaim(entry.data).turnId === turnId;
	});
	if (!hasClaim) throw new Error(`mailbox turn ${turnId} has no claim to commit`);
	const commit = parseCommit({
		version: MAILBOX_VERSION,
		turnId,
		userMessageDigest:
			userMessageDigest(userMessage)
			?? (() => {
				throw new Error("mailbox claim can be committed only by a user message");
			})(),
		committedAt: new Date().toISOString(),
	});
	session.appendCustomEntry(MAILBOX_COMMIT_CUSTOM_TYPE, commit);
}

export function formatMailboxBatch(
	messages: readonly MailboxMessage[],
	turnId: string,
): string {
	if (messages.length === 0) throw new Error("cannot format an empty mailbox batch");
	uuid(turnId, "mailbox batch turnId");
	const records = messages.map((message) =>
		JSON.stringify({
			message_id: message.messageId,
			sender_agent_id: message.senderAgentId,
			content: message.content,
		}),
	);
	return [
		`[[pi-subagent-mailbox-turn:${turnId}]]`,
		`Your direct parent queued ${messages.length} mailbox message${messages.length === 1 ? "" : "s"}.`,
		"Process this claimed batch as one follow-up task, preserving FIFO order and addressing every message.",
		"<mailbox_batch>",
		...records,
		"</mailbox_batch>",
	].join("\n");
}
