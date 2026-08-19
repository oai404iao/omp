import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	applyNativeCompactionContext,
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

function compactionEntry(
	mode: "responses" | "responses-compact" | "responses-context-management",
	output: unknown[],
	detailOverrides: Record<string, unknown> = {},
) {
	return {
		type: "compaction",
		id: "compact1",
		parentId: "old1",
		timestamp: new Date(5).toISOString(),
		summary: "placeholder",
		firstKeptEntryId: "old1",
		tokensBefore: 100,
		details: {
			kind: NATIVE_COMPACTION_DETAILS_KIND,
			version: mode === "responses-context-management" ? 1 : NATIVE_COMPACTION_DETAILS_VERSION,
			mode,
			provider: model.provider,
			model: model.id,
			api: model.api,
			output,
			...detailOverrides,
		},
	} as any;
}

const item = { type: "compaction", encrypted_content: "opaque-encrypted-state" };
const marker = {
	type: "thinking",
	thinking: "",
	thinkingSignature: JSON.stringify(item),
	redacted: true,
};

test("legacy v1 context-management details still replay the installed checkpoint", () => {
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
	const entries = [compactionEntry("responses-context-management", [item], {
		sourceEntryId: "source1",
		sourceBlockIndex: 1,
	})] as any;

	const result = applyNativeCompactionContext(messages, entries, model);

	assert.equal(result.length, 3);
	assert.equal((result[0] as any).content[0].thinkingSignature, JSON.stringify(item));
	assert.deepEqual((result[1] as any).content, [
		{ type: "toolCall", id: "call_1|fc_1", name: "read", arguments: { path: "a.ts" } },
	]);
	assert.equal((result[2] as any).role, "toolResult");
});

test("responses details replace old local messages and retain future turns", () => {
	const retainedUser = {
		type: "message",
		role: "user",
		content: [{ type: "input_text", text: "retained user" }],
	};
	const messages = [
		{ role: "compactionSummary", summary: "placeholder", tokensBefore: 100, timestamp: 5 },
		{ role: "user", content: "kept locally but replaced remotely", timestamp: 4 },
		{ role: "user", content: "future prompt", timestamp: 6 },
	] as any;
	const entries = [
		compactionEntry("responses", [retainedUser, item]),
		messageEntry("future1", "compact1", messages[2]),
	] as any;

	const result = applyNativeCompactionContext(messages, entries, model);

	assert.equal(result.length, 2);
	assert.deepEqual(
		(result[0] as any).content.map((block: any) => JSON.parse(block.thinkingSignature)),
		[retainedUser, item],
	);
	assert.equal((result[1] as any).content, "future prompt");
});

test("legacy /responses/compact output is sanitized before replay", () => {
	const retainedUser = {
		type: "message",
		role: "user",
		content: [{ type: "input_text", text: "retained user" }],
	};
	const compactedOutput = [
		retainedUser,
		{ type: "function_call", id: "fc_old", call_id: "call_old", name: "read", arguments: "{}" },
		{ type: "function_call_output", call_id: "call_old", output: "old result" },
		item,
	];
	const messages = [
		{ role: "compactionSummary", summary: "placeholder", tokensBefore: 100, timestamp: 5 },
	] as any;

	const result = applyNativeCompactionContext(
		messages,
		[compactionEntry("responses-compact", compactedOutput)] as any,
		model,
	);

	assert.deepEqual(
		(result[0] as any).content.map((block: any) => JSON.parse(block.thinkingSignature)),
		[retainedUser, item],
	);
});

test("post-compaction entries are retained by entry order even with older timestamps", () => {
	const queued = { role: "user", content: "queued while compacting", timestamp: 4 } as any;
	const messages = [
		{ role: "compactionSummary", summary: "placeholder", tokensBefore: 100, timestamp: 5 },
		{ role: "user", content: "pre-compaction retained UI message", timestamp: 4 },
		queued,
	] as any;
	const entries = [
		compactionEntry("responses", [item]),
		messageEntry("queued1", "compact1", queued),
	] as any;

	const result = applyNativeCompactionContext(messages, entries, model);

	assert.equal(result.length, 2);
	assert.equal((result[1] as any).content, "queued while compacting");
});

test("a newer Pi compaction prevents stale native state from being replayed", () => {
	const messages = [
		{ role: "compactionSummary", summary: "new Pi summary", tokensBefore: 50, timestamp: 8 },
		{ role: "user", content: "recent", timestamp: 9 },
	] as any;
	const entries = [
		{
			...compactionEntry("responses", [item]),
			id: "native1",
		},
		{
			type: "compaction",
			id: "pi2",
			parentId: "native1",
			timestamp: new Date(8).toISOString(),
			summary: "new Pi summary",
			firstKeptEntryId: "recent1",
			tokensBefore: 50,
		},
	] as any;

	assert.equal(applyNativeCompactionContext(messages, entries, model), messages);
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

test("responses compaction is requested through Pi's session compaction hook", async () => {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousFetch = globalThis.fetch;
	const agentDir = mkdtempSync(join(tmpdir(), "pi-native-compaction-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const configDir = join(agentDir, "extensions", "pi-codex-minimal-tools");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), JSON.stringify({
			compactionMode: "responses",
		}));

		let requestBody: any;
		let requestHeaders: Headers | undefined;
		globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
			requestBody = JSON.parse(String(init?.body));
			requestHeaders = new Headers(init?.headers as HeadersInit);
			const event = {
				type: "response.completed",
				response: {
					id: "resp_compact",
					status: "completed",
					output: [item],
					usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
				},
			};
			return new Response(`data: ${JSON.stringify(event)}\n\n`, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}) as typeof fetch;

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

		const requestModel = { ...model, baseUrl: "https://example.test/v1" } as Model<Api>;
		const prompt = { role: "user", content: "compact me", timestamp: 1 };
		const branch = [messageEntry("user1", null, prompt)];
		const result = await handlers.session_before_compact?.[0]?.({
			type: "session_before_compact",
			branchEntries: branch,
			preparation: {
				firstKeptEntryId: "user1",
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
			model: requestModel,
			getSystemPrompt: () => "system",
			modelRegistry: {
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key", headers: {} }),
			},
			sessionManager: {
				getLeafId: () => "user1",
				getSessionId: () => "session-1",
			},
			ui: { notify() {} },
		});

		assert.equal(result.compaction.firstKeptEntryId, "user1");
		assert.match(result.compaction.summary, /Responses compaction replaced/);
		assert.equal(result.compaction.details.version, NATIVE_COMPACTION_DETAILS_VERSION);
		assert.equal(result.compaction.details.mode, "responses");
		assert.deepEqual(result.compaction.details.output, [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "compact me" }] },
			item,
		]);
		assert.equal(result.compaction.details.sourceEntryId, undefined);
		assert.deepEqual(requestBody.input.at(-1), { type: "compaction_trigger" });
		assert.ok(
			typeof requestBody.prompt_cache_key === "string"
			&& /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestBody.prompt_cache_key),
		);
		assert.equal(requestHeaders?.get("session-id"), requestBody.prompt_cache_key);
		assert.equal(requestHeaders?.get("session_id"), null);
		assert.ok(
			requestHeaders?.get("x-codex-window-id")
			&& /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestHeaders.get("x-codex-window-id")!),
		);
		assert.equal(requestHeaders?.get("x-codex-beta-features"), "remote_compaction_v2");
	} finally {
		globalThis.fetch = previousFetch;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("session compaction resolves the active Pi turn id for provider transport", async () => {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = mkdtempSync(join(tmpdir(), "pi-native-compaction-turn-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const configDir = join(agentDir, "extensions", "pi-codex-minimal-tools");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), JSON.stringify({
			compactionMode: "responses",
			openaiTransport: "sse",
		}));

		const previousFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			const event = {
				type: "response.completed",
				response: {
					id: "resp_compact",
					status: "completed",
					output: [item],
					usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
				},
			};
			return new Response(`data: ${JSON.stringify(event)}\n\n`, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}) as typeof fetch;
		try {
			const handlers: Record<string, Function[]> = {};
			const pi = {
				on(event: string, handler: Function) { (handlers[event] ??= []).push(handler); },
				getActiveTools() { return []; },
				getAllTools() { return []; },
				getThinkingLevel() { return "off"; },
			};
			const turnLookups: Array<string | undefined> = [];
			registerNativeCompaction(pi as any, {
				getCurrentTurnId(sessionId) {
					turnLookups.push(sessionId);
					return "turn-active";
				},
			});

			await handlers.session_before_compact?.[0]?.({
				type: "session_before_compact",
				branchEntries: [messageEntry("user1", null, {
					role: "user",
					content: "compact me",
					timestamp: 1,
				})],
				preparation: {
					firstKeptEntryId: "user1",
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
				model: { ...model, baseUrl: "https://example.test/v1" },
				getSystemPrompt: () => "system",
				modelRegistry: {
					getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key", headers: {} }),
				},
				sessionManager: {
					getLeafId: () => "user1",
					getSessionId: () => "session-1",
				},
				ui: { notify() {} },
			});

			assert.deepEqual(turnLookups, ["session-1"]);
		} finally {
			globalThis.fetch = previousFetch;
		}
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("native opaque state is not replayed to unsupported providers", () => {
	const messages = [
		{ role: "compactionSummary", summary: "placeholder", tokensBefore: 100, timestamp: 5 },
	] as any;
	const other = { ...model, provider: "anthropic", id: "claude" } as Model<Api>;

	assert.equal(
		applyNativeCompactionContext(messages, [compactionEntry("responses", [item])] as any, other),
		messages,
	);
});
