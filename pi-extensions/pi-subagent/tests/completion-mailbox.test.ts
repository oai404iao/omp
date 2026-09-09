import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	appendCompletionUpdate,
	readCompletionMailbox,
	releaseCompletionDeliveries,
	reserveCompletionDelivery,
	unreadCompletionCounts,
} from "../src/completion-mailbox.ts";
import type { SubagentRunResult } from "../src/types.ts";

const PARENT_ID = "01900000-0000-7000-8000-000000000001";
const CHILD_ID = "01900000-0000-7000-8000-000000000002";
const TURN_ID = "01900000-0000-7000-8000-000000000003";
const RUNTIME_ONE = "01900000-0000-7000-8000-000000000004";
const RUNTIME_TWO = "01900000-0000-7000-8000-000000000005";

function result(): SubagentRunResult {
	return {
		agentId: CHILD_ID,
		turnId: TURN_ID,
		output: "completed output",
		stopReason: "completed",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
			turns: 1,
		},
	};
}

function appendWaitResult(
	session: SessionManager,
	toolCallId: string,
): void {
	session.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName: "wait_agent",
		content: [{ type: "text", text: "delivered" }],
		isError: false,
		timestamp: Date.now(),
	});
}

test("completion delivery becomes read only after its durable tool result", () => {
	const session = SessionManager.inMemory("/tmp/project");
	const update = appendCompletionUpdate(session, {
		parentAgentId: PARENT_ID,
		childAgentId: CHILD_ID,
		result: result(),
	});
	const duplicate = appendCompletionUpdate(session, {
		parentAgentId: PARENT_ID,
		childAgentId: CHILD_ID,
		result: result(),
	});
	assert.equal(duplicate.completionId, update.completionId);

	reserveCompletionDelivery(session, {
		parentAgentId: PARENT_ID,
		runtimeId: RUNTIME_ONE,
		toolCallId: "wait-call-1",
		completionIds: [update.completionId],
	});
	const reserved = readCompletionMailbox(session.getEntries(), {
		parentAgentId: PARENT_ID,
		activeRuntimeId: RUNTIME_ONE,
	});
	assert.equal(reserved.unread.length, 1);
	assert.equal(reserved.available.length, 0);
	assert.equal(reserved.currentRuntimeReservations.length, 1);

	appendWaitResult(session, "wait-call-1");
	const committed = readCompletionMailbox(session.getEntries(), {
		parentAgentId: PARENT_ID,
		activeRuntimeId: RUNTIME_ONE,
	});
	assert.equal(committed.unread.length, 0);
	assert.equal(committed.currentRuntimeReservations.length, 0);
});

test("an uncommitted delivery is recoverable by a new runtime", () => {
	const session = SessionManager.inMemory("/tmp/project");
	const update = appendCompletionUpdate(session, {
		parentAgentId: PARENT_ID,
		childAgentId: CHILD_ID,
		result: result(),
	});
	reserveCompletionDelivery(session, {
		parentAgentId: PARENT_ID,
		runtimeId: RUNTIME_ONE,
		toolCallId: "orphaned-wait",
		completionIds: [update.completionId],
	});
	const recovered = readCompletionMailbox(session.getEntries(), {
		parentAgentId: PARENT_ID,
		activeRuntimeId: RUNTIME_TWO,
	});
	assert.equal(recovered.unread.length, 1);
	assert.equal(recovered.available.length, 1);
	assert.equal(recovered.currentRuntimeReservations.length, 0);
});

test("a released failed delivery is recoverable in the same runtime", () => {
	const session = SessionManager.inMemory("/tmp/project");
	const update = appendCompletionUpdate(session, {
		parentAgentId: PARENT_ID,
		childAgentId: CHILD_ID,
		result: result(),
	});
	reserveCompletionDelivery(session, {
		parentAgentId: PARENT_ID,
		runtimeId: RUNTIME_ONE,
		toolCallId: "failed-wait",
		completionIds: [update.completionId],
	});
	assert.equal(
		releaseCompletionDeliveries(session, {
			parentAgentId: PARENT_ID,
			runtimeId: RUNTIME_ONE,
			reason: "parent turn aborted",
		}),
		1,
	);
	const recovered = readCompletionMailbox(session.getEntries(), {
		parentAgentId: PARENT_ID,
		activeRuntimeId: RUNTIME_ONE,
	});
	assert.equal(recovered.available.length, 1);
	assert.equal(recovered.currentRuntimeReservations.length, 0);
	appendWaitResult(session, "failed-wait");
	const afterLateResult = readCompletionMailbox(session.getEntries(), {
		parentAgentId: PARENT_ID,
		activeRuntimeId: RUNTIME_ONE,
	});
	assert.equal(afterLateResult.unread.length, 1);
	reserveCompletionDelivery(session, {
		parentAgentId: PARENT_ID,
		runtimeId: RUNTIME_ONE,
		toolCallId: "retried-wait",
		completionIds: [update.completionId],
	});
	appendWaitResult(session, "retried-wait");
	assert.equal(
		readCompletionMailbox(session.getEntries(), {
			parentAgentId: PARENT_ID,
			activeRuntimeId: RUNTIME_ONE,
		}).unread.length,
		0,
	);
});

test("unread completion counts stay separate per direct child", () => {
	const session = SessionManager.inMemory("/tmp/project");
	appendCompletionUpdate(session, {
		parentAgentId: PARENT_ID,
		childAgentId: CHILD_ID,
		result: result(),
	});
	const counts = unreadCompletionCounts(
		readCompletionMailbox(session.getEntries(), {
			parentAgentId: PARENT_ID,
		}),
	);
	assert.equal(counts.get(CHILD_ID), 1);
});
