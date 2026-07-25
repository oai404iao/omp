import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import type { Api } from "@earendil-works/pi-ai";
import {
	applyNativeCompactionContext,
	hasPendingNativeCompactionMarker,
	NATIVE_COMPACTION_DETAILS_KIND,
	NATIVE_COMPACTION_DETAILS_VERSION,
	normalizeNativeCompactionToolPairs,
	registerNativeCompaction,
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

function messageEntry(id: string, parentId: string | null, message: any) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(message.timestamp ?? 0).toISOString(),
		message,
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
	const entries = [
		messageEntry("user1", null, messages[0]),
		messageEntry("assistant1", "user1", messages[1]),
		messageEntry("assistant2", "assistant1", messages[2]),
	];

	const result = applyNativeCompactionContext(
		messages,
		entries,
		model,
		"responses-context-management",
	);

	assert.equal(result.length, 1);
	assert.deepEqual((result[0] as any).content, [marker, { type: "text", text: "after compaction" }]);
});

test("legacy terminal markers rotate before matched tool calls instead of orphaning their results", () => {
	const source = assistant([
		{ type: "toolCall", id: "call_1|fc_1", name: "read", arguments: { path: "a.ts" } },
		marker,
	], 3);
	const toolResult = {
		role: "toolResult",
		toolCallId: "call_1|fc_1",
		toolName: "read",
		content: [{ type: "text", text: "result" }],
		isError: false,
		timestamp: 4,
	};
	const messages = [
		{ role: "user", content: "old prompt", timestamp: 1 },
		source,
		toolResult,
	] as any;
	const entries = [
		messageEntry("user1", null, messages[0]),
		messageEntry("source1", "user1", source),
		messageEntry("result1", "source1", toolResult),
	];

	const result = applyNativeCompactionContext(
		messages,
		entries,
		model,
		"responses-context-management",
	) as any[];

	assert.deepEqual(result.map((message) => message.role), ["assistant", "toolResult"]);
	assert.deepEqual(result[0].content, [
		marker,
		{ type: "toolCall", id: "call_1|fc_1", name: "read", arguments: { path: "a.ts" } },
	]);
	assert.equal(result[1].toolCallId, "call_1|fc_1");
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
		{ type: "function_call", id: "fc_old", call_id: "call_old", name: "read", arguments: "{\"path\":\"old\"}" },
		{ type: "function_call_output", call_id: "call_old", output: "old result" },
		item,
	];
	const messages = [
		{ role: "compactionSummary", summary: "placeholder", tokensBefore: 100, timestamp: 5 },
		{ role: "user", content: "kept locally but replaced remotely", timestamp: 4 },
		{ role: "user", content: "future prompt", timestamp: 6 },
	] as any;
	const compactionEntry = {
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
	} as any;
	const entries = [
		compactionEntry,
		messageEntry("future1", "compact1", messages[2]),
	] as any;

	const result = applyNativeCompactionContext(messages, entries, model, "responses-compact");

	assert.equal(result.length, 2);
	assert.deepEqual(
		(result[0] as any).content.map((block: any) => JSON.parse(block.thinkingSignature)),
		[compactedOutput[0], item],
	);
	assert.equal((result[1] as any).content, "future prompt");
});

test("post-compaction entries are retained by entry order even when their timestamp is older", () => {
	const queued = { role: "user", content: "queued while compacting", timestamp: 4 } as any;
	const messages = [
		{ role: "compactionSummary", summary: "placeholder", tokensBefore: 100, timestamp: 5 },
		{ role: "user", content: "pre-compaction retained UI message", timestamp: 4 },
		queued,
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
	}, messageEntry("queued1", "compact1", queued)] as any;

	const result = applyNativeCompactionContext(messages, entries, model, "responses-compact");

	assert.equal(result.length, 2);
	assert.equal((result[1] as any).content, "queued while compacting");
});

test("a newer Pi compaction prevents stale native state from being replayed", () => {
	const messages = [
		{ role: "compactionSummary", summary: "new Pi summary", tokensBefore: 50, timestamp: 8 },
		{ role: "user", content: "recent", timestamp: 9 },
	] as any;
	const entries = [{
		type: "compaction",
		id: "native1",
		parentId: "old1",
		timestamp: new Date(5).toISOString(),
		summary: "native",
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
	}, {
		type: "compaction",
		id: "pi2",
		parentId: "native1",
		timestamp: new Date(8).toISOString(),
		summary: "new Pi summary",
		firstKeptEntryId: "recent1",
		tokensBefore: 50,
	}] as any;

	assert.equal(applyNativeCompactionContext(messages, entries, model, "responses-compact"), messages);
});

test("tool-call normalization removes orphan outputs and fills missing outputs atomically", () => {
	const calls = assistant([
		{ type: "toolCall", id: "call_a|fc_a", name: "read", arguments: { path: "a.ts" } },
		{ type: "toolCall", id: "call_b|fc_b", name: "read", arguments: { path: "b.ts" } },
	], 1);
	const resultA = {
		role: "toolResult",
		toolCallId: "call_a|fc_a",
		toolName: "read",
		content: [{ type: "text", text: "a" }],
		isError: false,
		timestamp: 2,
	};
	const orphan = {
		role: "toolResult",
		toolCallId: "call_z|fc_z",
		toolName: "read",
		content: [{ type: "text", text: "z" }],
		isError: false,
		timestamp: 2,
	};

	const result = normalizeNativeCompactionToolPairs([orphan, calls, resultA] as any) as any[];

	assert.deepEqual(result.map((message) => message.role), ["assistant", "toolResult", "toolResult"]);
	assert.equal(result[1].toolCallId, "call_a|fc_a");
	assert.equal(result[1].content[0].text, "a");
	assert.equal(result[2].toolCallId, "call_b|fc_b");
	assert.equal(result[2].content[0].text, "aborted");
	assert.equal(result[2].isError, true);
});

test("only markers after the latest compaction boundary are pending", () => {
	const source = assistant([marker], 3);
	const branch = [
		messageEntry("source1", null, source),
		{
			type: "compaction",
			id: "compact1",
			parentId: "source1",
			timestamp: new Date(5).toISOString(),
			summary: "done",
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
				sourceBlockIndex: 0,
			},
		},
	] as any;

	assert.equal(hasPendingNativeCompactionMarker(branch), false);
	branch.push(messageEntry("source2", "compact1", assistant([marker], 6)));
	assert.equal(hasPendingNativeCompactionMarker(branch), true);
});

test("native compaction is supplied through Pi's session compaction hook", async () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const agentDir = mkdtempSync(join(tmpdir(), "pi-native-compaction-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const configDir = join(agentDir, "extensions", "pi-codex-minimal-tools");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), JSON.stringify({
			compactionMode: "responses-context-management",
		}));

		const handlers: Record<string, Function[]> = {};
		const pi = {
			on(event: string, handler: Function) { (handlers[event] ??= []).push(handler); },
			getActiveTools() { return []; },
			getAllTools() { return []; },
			getThinkingLevel() { return "off"; },
		};
		registerNativeCompaction(pi as any);
		assert.equal(handlers.agent_end, undefined);
		assert.equal(handlers.input, undefined);

		const source = assistant([
			marker,
			{ type: "toolCall", id: "call_1|fc_1", name: "read", arguments: { path: "a.ts" } },
		], 3);
		const branch = [messageEntry("source1", null, source)];
		const result = await handlers.session_before_compact?.[0]?.({
			type: "session_before_compact",
			branchEntries: branch,
			preparation: {
				firstKeptEntryId: "source1",
				messagesToSummarize: [],
				turnPrefixMessages: [],
				isSplitTurn: false,
				tokensBefore: 100,
				fileOps: { read: new Set(), modified: new Set() },
				settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
			},
			signal: new AbortController().signal,
		}, {
			cwd: process.cwd(),
			model,
		});

		assert.equal(result.compaction.firstKeptEntryId, "source1");
		assert.match(result.compaction.summary, /compaction trigger compacted/);
		assert.deepEqual(result.compaction.details.output, [item]);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	}
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
