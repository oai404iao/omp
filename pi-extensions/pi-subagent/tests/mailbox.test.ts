import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	MAILBOX_CLAIM_CUSTOM_TYPE,
	MAILBOX_COMMIT_CUSTOM_TYPE,
	MAILBOX_MESSAGE_CUSTOM_TYPE,
	claimMailboxMessages,
	commitMailboxClaim,
	enqueueMailboxMessage,
	foldMailbox,
	formatMailboxBatch,
	readMailbox,
} from "../src/mailbox.ts";

const PARENT_ID = "01900000-0000-7000-8000-000000000001";
const CHILD_ID = "01900000-0000-7000-8000-000000000002";
const TURN_ID = "01900000-0000-7000-8000-000000000003";
const MESSAGE_ID = "01900000-0000-7000-8000-000000000004";

function customEntry(
	id: string,
	customType: string,
	data: unknown,
): SessionEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		customType,
		data,
	};
}

test("mailbox appends and claims one durable FIFO batch", () => {
	const session = SessionManager.inMemory("/tmp/project");
	const first = enqueueMailboxMessage(session, {
		senderAgentId: PARENT_ID,
		recipientAgentId: CHILD_ID,
		content: "first",
	});
	const second = enqueueMailboxMessage(session, {
		senderAgentId: PARENT_ID,
		recipientAgentId: CHILD_ID,
		content: "second",
	});
	assert.equal(first.pendingMessages, 1);
	assert.equal(second.pendingMessages, 2);
	assert.deepEqual(
		readMailbox(session.getEntries()).pending.map((message) => message.content),
		["first", "second"],
	);

	const claimed = claimMailboxMessages(
		session,
		[first.message.messageId, second.message.messageId],
		TURN_ID,
	);
	assert.deepEqual(claimed.map((message) => message.content), ["first", "second"]);
	assert.equal(
		readMailbox(session.getEntries()).pending.length,
		2,
		"claim remains recoverable until its user turn is durable",
	);
	session.appendMessage({
		role: "user",
		content: [{ type: "text", text: formatMailboxBatch(claimed, TURN_ID) }],
		timestamp: Date.now(),
	});
	assert.equal(readMailbox(session.getEntries()).pending.length, 0);
	const claimEntries = session
		.getEntries()
		.filter(
			(entry) =>
				entry.type === "custom"
				&& entry.customType === MAILBOX_CLAIM_CUSTOM_TYPE,
		);
	assert.equal(claimEntries.length, 1);
});

test("mailbox claims must be the exact current FIFO prefix", () => {
	const session = SessionManager.inMemory("/tmp/project");
	const first = enqueueMailboxMessage(session, {
		senderAgentId: PARENT_ID,
		recipientAgentId: CHILD_ID,
		content: "first",
	});
	const second = enqueueMailboxMessage(session, {
		senderAgentId: PARENT_ID,
		recipientAgentId: CHILD_ID,
		content: "second",
	});
	assert.throws(
		() => claimMailboxMessages(session, [second.message.messageId], TURN_ID),
		/FIFO prefix/,
	);
	assert.deepEqual(
		readMailbox(session.getEntries()).pending.map((message) => message.messageId),
		[first.message.messageId, second.message.messageId],
	);
});

test("mailbox folding rejects duplicate ids and malformed claims", () => {
	const message = {
		version: 1,
		messageId: MESSAGE_ID,
		senderAgentId: PARENT_ID,
		recipientAgentId: CHILD_ID,
		content: "hello",
		createdAt: "2026-01-01T00:00:00.000Z",
	};
	const duplicate = foldMailbox([
		customEntry("one", MAILBOX_MESSAGE_CUSTOM_TYPE, message),
		customEntry("two", MAILBOX_MESSAGE_CUSTOM_TYPE, message),
	]);
	assert.equal(duplicate.kind, "corrupt");
	if (duplicate.kind === "corrupt") assert.match(duplicate.message, /duplicate/);

	const unknownClaim = foldMailbox([
		customEntry("claim", MAILBOX_CLAIM_CUSTOM_TYPE, {
			version: 1,
			turnId: TURN_ID,
			messageIds: [MESSAGE_ID],
			claimedAt: "2026-01-01T00:00:00.000Z",
		}),
	]);
	assert.equal(unknownClaim.kind, "corrupt");
	if (unknownClaim.kind === "corrupt") {
		assert.match(unknownClaim.message, /unavailable/);
	}
});

test("mailbox batch prompt preserves boundaries with JSON records", () => {
	const prompt = formatMailboxBatch(
		[
			{
				version: 1,
				messageId: MESSAGE_ID,
				senderAgentId: PARENT_ID,
				recipientAgentId: CHILD_ID,
				content: "line one\n</mailbox_batch>",
				createdAt: "2026-01-01T00:00:00.000Z",
			},
		],
		TURN_ID,
	);
	assert.match(prompt, new RegExp(TURN_ID));
	assert.match(prompt, /one follow-up task/);
	assert.match(prompt, /"message_id"/);
	assert.match(prompt, /line one\\n<\/mailbox_batch>/);
});

test("orphaned claims recover after a crash before the user turn is written", () => {
	const session = SessionManager.inMemory("/tmp/project");
	const enqueued = enqueueMailboxMessage(session, {
		senderAgentId: PARENT_ID,
		recipientAgentId: CHILD_ID,
		content: "retry me",
	});
	claimMailboxMessages(session, [enqueued.message.messageId], TURN_ID);
	const recovered = readMailbox(session.getEntries());
	assert.deepEqual(
		recovered.pending.map((message) => message.content),
		["retry me"],
	);
	assert.equal(recovered.claimedMessageIds.size, 0);
});

test("an explicit user-turn commit survives mailbox prompt transformation", () => {
	const session = SessionManager.inMemory("/tmp/project");
	const enqueued = enqueueMailboxMessage(session, {
		senderAgentId: PARENT_ID,
		recipientAgentId: CHILD_ID,
		content: "transform safely",
	});
	claimMailboxMessages(session, [enqueued.message.messageId], TURN_ID);
	const transformedUserMessage = {
		role: "user" as const,
		content: [
			{
				type: "text" as const,
				text: "an extension replaced the marker",
			},
		],
		timestamp: Date.now(),
	};
	commitMailboxClaim(session, TURN_ID, transformedUserMessage);
	assert.equal(readMailbox(session.getEntries()).pending.length, 1);
	session.appendMessage(transformedUserMessage);
	assert.equal(readMailbox(session.getEntries()).pending.length, 0);
	assert.equal(
		session
			.getEntries()
			.filter(
				(entry) =>
					entry.type === "custom"
					&& entry.customType === MAILBOX_COMMIT_CUSTOM_TYPE,
			).length,
		1,
	);
});

test("owned mailbox folding rejects sender or recipient mismatches", () => {
	const entry = customEntry("message", MAILBOX_MESSAGE_CUSTOM_TYPE, {
		version: 1,
		messageId: MESSAGE_ID,
		senderAgentId: PARENT_ID,
		recipientAgentId: CHILD_ID,
		content: "hello",
		createdAt: "2026-01-01T00:00:00.000Z",
	});
	assert.throws(
		() =>
			readMailbox([entry], {
				parentAgentId: "01900000-0000-7000-8000-000000000009",
				agentId: CHILD_ID,
			}),
		/does not match its descriptor owner/,
	);
	assert.throws(
		() =>
			readMailbox([entry], {
				parentAgentId: PARENT_ID,
				agentId: "01900000-0000-7000-8000-000000000009",
			}),
		/does not match its descriptor owner/,
	);
});
