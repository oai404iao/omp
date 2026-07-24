import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import type { Api } from "@earendil-works/pi-ai";
import {
	applyNativeCompactionContext,
	NATIVE_COMPACTION_DETAILS_KIND,
	NATIVE_COMPACTION_DETAILS_VERSION,
} from "../src/native-compaction.js";

const model = {
	provider: "openai",
	api: "openai-responses",
	id: "gpt-5.5",
	input: ["text"],
	reasoning: true,
	contextWindow: 400_000,
	maxTokens: 16_384,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as Model<Api>;

function usage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(content: any[], timestamp: number) {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content,
		usage: usage(),
		stopReason: "stop",
		timestamp,
	} as any;
}

const item = { type: "compaction", encrypted_content: "opaque-encrypted-state" };
const marker = {
	type: "thinking",
	thinking: "",
	thinkingSignature: JSON.stringify(item),
	redacted: true,
};

test("uninstalled context_management markers trim prior messages and retain subsequent content", () => {
	const messages = [
		{ role: "user", content: "old prompt", timestamp: 1 },
		assistant([{ type: "text", text: "old reply" }], 2),
		assistant([marker, { type: "text", text: "after compaction" }], 3),
	] as any;

	const result = applyNativeCompactionContext(
		messages,
		[],
		model,
		"responses-context-management",
	);

	assert.equal(result.length, 1);
	assert.deepEqual((result[0] as any).content, [marker, { type: "text", text: "after compaction" }]);
});

test("installed context_management details replay opaque state and keep the source tail", () => {
	const source = assistant([
		{ type: "text", text: "before compaction" },
		marker,
		{ type: "toolCall", id: "call_1|fc_1", name: "read", arguments: { path: "a.ts" } },
	], 3);
	const messages = [
		{ role: "compactionSummary", summary: "placeholder", tokensBefore: 100, timestamp: 5 },
		source,
		{
			role: "toolResult",
			toolCallId: "call_1|fc_1",
			toolName: "read",
			content: [{ type: "text", text: "result" }],
			isError: false,
			timestamp: 4,
		},
	] as any;
	const entries = [{
		type: "compaction",
		id: "compact1",
		parentId: "source1",
		timestamp: new Date(5).toISOString(),
		summary: "placeholder",
		firstKeptEntryId: "source1",
		tokensBefore: 100,
		details: {
			kind: NATIVE_COMPACTION_DETAILS_KIND,
			version: NATIVE_COMPACTION_DETAILS_VERSION,
			mode: "responses-context-management",
			provider: model.provider,
			model: model.id,
			api: model.api,
			output: [item],
			sourceEntryId: "source1",
			sourceBlockIndex: 1,
		},
	}] as any;

	const result = applyNativeCompactionContext(
		messages,
		entries,
		model,
		"responses-context-management",
	);

	assert.equal(result.length, 3);
	assert.equal((result[0] as any).role, "assistant");
	assert.equal((result[0] as any).content[0].thinkingSignature, JSON.stringify(item));
	assert.deepEqual((result[1] as any).content, [
		{ type: "toolCall", id: "call_1|fc_1", name: "read", arguments: { path: "a.ts" } },
	]);
	assert.equal((result[2] as any).role, "toolResult");
});

test("legacy /responses/compact details replace old local messages and retain future turns", () => {
	const compactedOutput = [
		{ type: "message", role: "user", content: [{ type: "input_text", text: "retained user" }] },
		item,
	];
	const messages = [
		{ role: "compactionSummary", summary: "placeholder", tokensBefore: 100, timestamp: 5 },
		{ role: "user", content: "kept locally but replaced remotely", timestamp: 4 },
		{ role: "user", content: "future prompt", timestamp: 6 },
	] as any;
	const entries = [{
		type: "compaction",
		id: "compact1",
		parentId: "old1",
		timestamp: new Date(5).toISOString(),
		summary: "placeholder",
		firstKeptEntryId: "old1",
		tokensBefore: 100,
		details: {
			kind: NATIVE_COMPACTION_DETAILS_KIND,
			version: NATIVE_COMPACTION_DETAILS_VERSION,
			mode: "responses-compact",
			provider: model.provider,
			model: model.id,
			api: model.api,
			output: compactedOutput,
		},
	}] as any;

	const result = applyNativeCompactionContext(messages, entries, model, "responses-compact");

	assert.equal(result.length, 2);
	assert.deepEqual(
		(result[0] as any).content.map((block: any) => JSON.parse(block.thinkingSignature)),
		compactedOutput,
	);
	assert.equal((result[1] as any).content, "future prompt");
});

test("native opaque state is not replayed to unsupported providers", () => {
	const messages = [
		{ role: "compactionSummary", summary: "placeholder", tokensBefore: 100, timestamp: 5 },
	] as any;
	const entries = [{
		type: "compaction",
		id: "compact1",
		parentId: "old1",
		timestamp: new Date(5).toISOString(),
		summary: "placeholder",
		firstKeptEntryId: "old1",
		tokensBefore: 100,
		details: {
			kind: NATIVE_COMPACTION_DETAILS_KIND,
			version: NATIVE_COMPACTION_DETAILS_VERSION,
			mode: "responses-compact",
			provider: model.provider,
			model: model.id,
			api: model.api,
			output: [item],
		},
	}] as any;
	const other = { ...model, provider: "anthropic", id: "claude" } as Model<Api>;

	assert.equal(applyNativeCompactionContext(messages, entries, other, "responses-compact"), messages);
});
