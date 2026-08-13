import assert from "node:assert/strict";
import test from "node:test";
import { convertResponsesMessages, processResponsesStream } from "../src/providers/openai-responses-shared.js";

async function* asAsyncIterable(events: any[]) {
	for (const event of events) yield event;
}

function createAssistantOutput() {
	return {
		role: "assistant",
		content: [],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-5.5",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	} as any;
}

const model = {
	provider: "openai-codex",
	api: "openai-codex-responses",
	id: "gpt-5.5",
	input: ["text"],
	reasoning: true,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as any;

// earendil-works/pi#5819: OpenAI-compatible streams (e.g. vLLM) can emit
// reasoning -> empty message (content: null) -> function_call. Before the null
// guard, the message branch of response.output_item.done did item.content.map()
// with no guard, threw TypeError, aborted the stream, and silently dropped the
// tool call. This asserts the tool call survives a null-content message item.
test("processResponsesStream tolerates a null-content message item before a function_call", async () => {
	const output = createAssistantOutput();

	await processResponsesStream(
		asAsyncIterable([
			{ type: "response.created", response: { id: "resp_1" } },
			{ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
			{ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1", content: null } },
			{ type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: "" } },
			{ type: "response.function_call_arguments.done", output_index: 1, arguments: '{"path":"/tmp/x"}' },
			{ type: "response.output_item.done", output_index: 1, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: '{"path":"/tmp/x"}' } },
			{ type: "response.completed", response: { id: "resp_1", status: "completed", usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0 } } } },
		]),
		output,
		{ push() {} } as any,
		model,
	);

	const toolCalls = output.content.filter((block: any) => block.type === "toolCall");
	assert.equal(toolCalls.length, 1, "tool call should survive a null-content message item");
	assert.equal(toolCalls[0].name, "read");
	assert.deepEqual(toolCalls[0].arguments, { path: "/tmp/x" });
	assert.equal(output.stopReason, "toolUse");

	const textBlocks = output.content.filter((block: any) => block.type === "text");
	assert.equal(textBlocks[0]?.text, "", "null message content collapses to empty text");
});

test("processResponsesStream maps custom raw deltas to apply_patch input", async () => {
	const output = createAssistantOutput();
	const streamEvents: Array<{ type: string; delta?: string }> = [];
	const patch = "*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch\n";

	await processResponsesStream(
		asAsyncIterable([
			{ type: "response.created", response: { id: "resp_custom" } },
			{ type: "response.output_item.added", output_index: 0, item: { type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "apply_patch", input: "" } },
			{ type: "response.custom_tool_call_input.delta", item_id: "ctc_1", call_id: "call_1", delta: "*** Begin Patch\n" },
			{ type: "response.custom_tool_call_input.delta", item_id: "ctc_1", call_id: "call_1", delta: "*** Add File: a.txt\n+x\n*** End Patch\n" },
			{ type: "response.output_item.done", output_index: 0, item: { type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "apply_patch", input: patch } },
			{ type: "response.completed", response: { id: "resp_custom", status: "completed", usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0 } } } },
		]),
		output,
		{ push(event: any) { streamEvents.push({ type: event.type, ...(typeof event.delta === "string" ? { delta: event.delta } : {}) }); } } as any,
		model,
	);

	const toolCall = output.content.find((block: any) => block.type === "toolCall") as any;
	assert.equal(toolCall.id, "call_1|ctc_1");
	assert.equal(toolCall.name, "apply_patch");
	assert.deepEqual(toolCall.arguments, { input: patch });
	assert.equal("partialInput" in toolCall, false);
	assert.deepEqual(streamEvents.map((event) => event.type), ["toolcall_start", "toolcall_delta", "toolcall_delta", "toolcall_end"]);
	assert.equal(streamEvents.filter((event) => event.type === "toolcall_delta").map((event) => event.delta).join(""), patch);
	assert.equal(output.stopReason, "toolUse");
});

test("processResponsesStream routes interleaved custom deltas by item id", async () => {
	const output = createAssistantOutput();
	await processResponsesStream(
		asAsyncIterable([
			{ type: "response.created", response: { id: "resp_parallel" } },
			{ type: "response.output_item.added", output_index: 0, item: { type: "custom_tool_call", id: "ctc_a", call_id: "call_a", name: "apply_patch", input: "" } },
			{ type: "response.output_item.added", output_index: 1, item: { type: "custom_tool_call", id: "ctc_b", call_id: "call_b", name: "apply_patch", input: "" } },
			{ type: "response.custom_tool_call_input.delta", item_id: "ctc_b", delta: "patch-b" },
			{ type: "response.custom_tool_call_input.delta", item_id: "ctc_a", delta: "patch-a" },
			{ type: "response.output_item.done", output_index: 0, item: { type: "custom_tool_call", id: "ctc_a", call_id: "call_a", name: "apply_patch", input: "patch-a" } },
			{ type: "response.output_item.done", output_index: 1, item: { type: "custom_tool_call", id: "ctc_b", call_id: "call_b", name: "apply_patch", input: "patch-b" } },
			{ type: "response.completed", response: { id: "resp_parallel", status: "completed", usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0 } } } },
		]),
		output,
		{ push() {} } as any,
		model,
	);

	const toolCalls = output.content.filter((block: any) => block.type === "toolCall") as any[];
	assert.deepEqual(toolCalls.map((call) => call.arguments.input), ["patch-a", "patch-b"]);
});

test("convertResponsesMessages replays custom calls and outputs by ctc item id", () => {
	const patch = "*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch\n";
	const messages = convertResponsesMessages(model, {
		systemPrompt: "",
		tools: [],
		messages: [
			{
				...createAssistantOutput(),
				content: [{ type: "toolCall", id: "call_1|ctc_1", name: "apply_patch", arguments: { input: patch } }],
				stopReason: "toolUse",
			},
			{
				role: "toolResult",
				toolCallId: "call_1|ctc_1",
				toolName: "apply_patch",
				content: [{ type: "text", text: "Applied patch" }],
				isError: false,
				timestamp: Date.now(),
			},
		],
	} as any, new Set(["openai-codex"]), { includeSystemPrompt: false }) as any[];

	assert.deepEqual(messages[0], {
		type: "custom_tool_call",
		id: "ctc_1",
		call_id: "call_1",
		name: "apply_patch",
		input: patch,
	});
	assert.deepEqual(messages[1], {
		type: "custom_tool_call_output",
		call_id: "call_1",
		output: "Applied patch",
	});
});

test("namespaced function calls map to Pi tool names and replay their wire identity", async () => {
	const output = createAssistantOutput();
	await processResponsesStream(
		asAsyncIterable([
			{ type: "response.created", response: { id: "resp_namespace" } },
			{
				type: "response.output_item.added",
				output_index: 0,
				item: {
					type: "function_call",
					id: "fc_web",
					call_id: "call_web",
					namespace: "web",
					name: "run",
					arguments: "",
				},
			},
			{
				type: "response.function_call_arguments.done",
				output_index: 0,
				arguments: '{"search_query":[{"q":"latest docs"}]}',
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "function_call",
					id: "fc_web",
					call_id: "call_web",
					namespace: "web",
					name: "run",
					arguments: '{"search_query":[{"q":"latest docs"}]}',
				},
			},
			{
				type: "response.completed",
				response: {
					id: "resp_namespace",
					status: "completed",
					usage: {
						input_tokens: 0,
						output_tokens: 0,
						total_tokens: 0,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		]),
		output,
		{ push() {} } as any,
		model,
	);

	const toolCall = output.content.find((block: any) => block.type === "toolCall") as any;
	assert.equal(toolCall.name, "web_search");
	assert.match(toolCall.thoughtSignature, /^pi:codex-tool-namespace:/);

	const replay = convertResponsesMessages(model, {
		systemPrompt: "",
		tools: [],
		messages: [
			output,
			{
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				content: [{ type: "text", text: "search result" }],
				isError: false,
				timestamp: Date.now(),
			},
		],
	} as any, new Set(["openai-codex"]), { includeSystemPrompt: false }) as any[];

	assert.deepEqual(replay[0], {
		type: "function_call",
		id: "fc_web",
		call_id: "call_web",
		namespace: "web",
		name: "run",
		arguments: '{"search_query":[{"q":"latest docs"}]}',
	});
	assert.equal(replay[1].type, "function_call_output");
	assert.equal(replay[1].call_id, "call_web");
	assert.deepEqual(replay[1].output, [
		{ type: "input_text", text: "search result" },
	]);
});

test("namespaced custom calls retain the functions namespace across replay", async () => {
	const output = createAssistantOutput();
	const patch = "*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch\n";
	await processResponsesStream(
		asAsyncIterable([
			{ type: "response.created", response: { id: "resp_custom_namespace" } },
			{
				type: "response.output_item.added",
				output_index: 0,
				item: {
					type: "custom_tool_call",
					id: "ctc_namespace",
					call_id: "call_patch",
					namespace: "functions",
					name: "apply_patch",
					input: "",
				},
			},
			{
				type: "response.custom_tool_call_input.delta",
				item_id: "ctc_namespace",
				call_id: "call_patch",
				delta: patch,
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "custom_tool_call",
					id: "ctc_namespace",
					call_id: "call_patch",
					namespace: "functions",
					name: "apply_patch",
					input: patch,
				},
			},
			{
				type: "response.completed",
				response: {
					id: "resp_custom_namespace",
					status: "completed",
					usage: {
						input_tokens: 0,
						output_tokens: 0,
						total_tokens: 0,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		]),
		output,
		{ push() {} } as any,
		model,
	);

	const toolCall = output.content.find((block: any) => block.type === "toolCall") as any;
	assert.equal(toolCall.name, "apply_patch");
	assert.match(toolCall.thoughtSignature, /^pi:codex-tool-namespace:/);
	const replay = convertResponsesMessages(model, {
		systemPrompt: "",
		tools: [],
		messages: [output],
	} as any, new Set(["openai-codex"]), { includeSystemPrompt: false }) as any[];
	assert.deepEqual(replay[0], {
		type: "custom_tool_call",
		id: "ctc_namespace",
		call_id: "call_patch",
		namespace: "functions",
		name: "apply_patch",
		input: patch,
	});
});

test("convertResponsesMessages omits rendered web search activity from model history", () => {
	const messages = convertResponsesMessages(model, {
		systemPrompt: "",
		tools: [],
		messages: [{
			...createAssistantOutput(),
			content: [
				{
					type: "text",
					text: "● **Searched the web** for latest docs",
					textSignature: "pi:web-search-activity:ws_123",
				},
				{
					type: "text",
					text: "Final answer",
					textSignature: JSON.stringify({ v: 1, id: "msg_123" }),
				},
			],
		}],
	} as any, new Set(["openai-codex"]), { includeSystemPrompt: false }) as any[];

	assert.equal(messages.length, 1);
	assert.equal(messages[0].type, "message");
	assert.equal(messages[0].content[0].text, "Final answer");
});

test("processResponsesStream preserves opaque compaction items for exact replay", async () => {
	const output = createAssistantOutput();
	const compaction = {
		type: "compaction",
		id: "cmp_1",
		encrypted_content: "opaque-encrypted-state",
	};

	await processResponsesStream(
		asAsyncIterable([
			{ type: "response.created", response: { id: "resp_compact" } },
			{ type: "response.output_item.done", output_index: 0, item: compaction },
			{
				type: "response.completed",
				response: {
					id: "resp_compact",
					status: "completed",
					output: [compaction],
					usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11, input_tokens_details: { cached_tokens: 0 } },
				},
			},
		]),
		output,
		{ push() {} } as any,
		model,
	);

	const hidden = output.content.find((block: any) =>
		block.type === "thinking" && block.redacted && block.thinking === "") as any;
	assert.ok(hidden);
	assert.deepEqual(JSON.parse(hidden.thinkingSignature), compaction);

	const replay = convertResponsesMessages(model, {
		systemPrompt: "",
		tools: [],
		messages: [output],
	} as any, new Set(["openai-codex"]), { includeSystemPrompt: false }) as any[];
	assert.deepEqual(replay, [compaction]);
});

test("terminal-only compaction is ordered before an already-streamed tool call", async () => {
	const output = createAssistantOutput();
	const compaction = {
		type: "compaction",
		id: "cmp_1",
		encrypted_content: "opaque-encrypted-state",
	};
	const functionCall = {
		type: "function_call",
		id: "fc_1",
		call_id: "call_1",
		name: "read",
		arguments: '{"path":"a.ts"}',
	};

	await processResponsesStream(
		asAsyncIterable([
			{ type: "response.created", response: { id: "resp_compact_call" } },
			{ type: "response.output_item.added", output_index: 1, item: { ...functionCall, arguments: "" } },
			{ type: "response.function_call_arguments.done", output_index: 1, arguments: functionCall.arguments },
			{ type: "response.output_item.done", output_index: 1, item: functionCall },
			{
				type: "response.completed",
				response: {
					id: "resp_compact_call",
					status: "completed",
					output: [compaction, functionCall],
					usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11, input_tokens_details: { cached_tokens: 0 } },
				},
			},
		]),
		output,
		{ push() {} } as any,
		model,
	);

	assert.deepEqual(output.content.map((block: any) => block.type), ["thinking", "toolCall"]);
	assert.deepEqual((output.content[1] as any).arguments, { path: "a.ts" });

	const replay = convertResponsesMessages(model, {
		systemPrompt: "",
		tools: [],
		messages: [
			output,
			{
				role: "toolResult",
				toolCallId: "call_1|fc_1",
				toolName: "read",
				content: [{ type: "text", text: "result" }],
				isError: false,
				timestamp: Date.now(),
			},
		],
	} as any, new Set(["openai-codex"]), { includeSystemPrompt: false }) as any[];
	assert.deepEqual(replay.map((item) => item.type), [
		"compaction",
		"function_call",
		"function_call_output",
	]);
});

test("processResponsesStream records reasoning token usage and incomplete stop reason", async () => {
	const output = createAssistantOutput();

	await processResponsesStream(
		asAsyncIterable([
			{ type: "response.created", response: { id: "resp_2" } },
			{ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1" } },
			{ type: "response.reasoning_text.delta", output_index: 0, delta: "hidden chain" },
			{ type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [], content: [{ text: "preserved reasoning" }] } },
			{ type: "response.incomplete", response: { id: "resp_2", status: "incomplete", usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 5 } } } },
		]),
		output,
		{ push() {} } as any,
		model,
	);

	assert.equal(output.stopReason, "length");
	assert.equal(output.usage.input, 8);
	assert.equal((output.usage as any).reasoning, 5);
	const thinking = output.content.find((block: any) => block.type === "thinking") as any;
	assert.equal(thinking.thinking, "preserved reasoning");
});

test("processResponsesStream fails when stream ends before terminal response event", async () => {
	const output = createAssistantOutput();
	await assert.rejects(
		() => processResponsesStream(
			asAsyncIterable([
				{ type: "response.created", response: { id: "resp_missing_terminal" } },
				{ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
				{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "partial" },
			]),
			output,
			{ push() {} } as any,
			model,
		),
		/OpenAI Responses stream ended before a terminal response event/,
	);
});
