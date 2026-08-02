import assert from "node:assert/strict";
import test from "node:test";
import {
	collectHistoricalCitationSources,
	collectWebSearchCitationSources,
	convertResponsesMessages,
	encodeWebSearchActivityTextSignature,
	processResponsesStream,
} from "../src/providers/openai-responses-shared.js";

async function* asAsyncIterable(events: any[]) {
	for (const event of events) yield event;
}

function createAssistantOutput() {
	return {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5.6-sol",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	} as any;
}

const model = {
	provider: "openai",
	api: "openai-responses",
	id: "gpt-5.6-sol",
	input: ["text"],
	reasoning: true,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as any;

const searchItem = {
	type: "web_search_call",
	id: "ws_123",
	status: "completed",
	action: {
		type: "search",
		query: "latest docs",
		sources: [
			{ type: "url", url: "https://example.com/source" },
			{ type: "url", url: "https://docs.example.org/page" },
		],
	},
	results: [
		{
			type: "text_result",
			snippet: "citeturn0search2 First result",
			title: "First result",
			url: "https://example.com/source",
		},
		{
			type: "text_result",
			snippet: "citeturn1view0 Opened page",
			title: "Opened page",
			url: "https://docs.example.org/page",
		},
	],
};

const firstMessageItem = {
	type: "message",
	id: "msg_first",
	role: "assistant",
	status: "completed",
	phase: "final_answer",
	content: [{
		type: "output_text",
		text: "Example source",
		annotations: [{
			type: "url_citation",
			start_index: 0,
			end_index: 14,
			title: "First result",
			url: "https://example.com/source",
		}],
	}],
};

test("web search results and message annotations survive exact history replay", async () => {
	const output = createAssistantOutput();
	await processResponsesStream(
		asAsyncIterable([
			{ type: "response.created", response: { id: "resp_first" } },
			{ type: "response.output_item.done", output_index: 0, item: searchItem },
			{ type: "response.output_item.done", output_index: 1, item: firstMessageItem },
			{ type: "response.completed", response: { id: "resp_first", status: "completed", output: [searchItem, firstMessageItem], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0 } } } },
		]),
		output,
		{ push() {} } as any,
		model,
	);

	output.content.unshift({
		type: "text",
		text: "● **Searched the web** for latest docs",
		textSignature: encodeWebSearchActivityTextSignature(searchItem.id, searchItem),
	} as any);

	assert.equal((output.content[1] as any).text, "[Example source](https://example.com/source)");
	const replay = convertResponsesMessages(
		model,
		{ systemPrompt: "", tools: [], messages: [output] } as any,
		new Set(["openai"]),
		{ includeSystemPrompt: false },
	) as any[];

	assert.deepEqual(replay, [searchItem, firstMessageItem]);
	assert.deepEqual(collectWebSearchCitationSources(model, { messages: [output] } as any), [
		{ refId: "turn0search2", title: "First result", url: "https://example.com/source" },
		{ refId: "turn1view0", title: "Opened page", url: "https://docs.example.org/page" },
	]);
	assert.deepEqual(collectHistoricalCitationSources(model, { messages: [output] } as any), [
		{ title: "Example source", url: "https://example.com/source" },
	]);
});

test("second-turn internal citation markers render from replayed web search results", async () => {
	const firstOutput = createAssistantOutput();
	firstOutput.content.push({
		type: "text",
		text: "● **Searched the web** for latest docs",
		textSignature: encodeWebSearchActivityTextSignature(searchItem.id, searchItem),
	});
	const citationSources = collectWebSearchCitationSources(model, { messages: [firstOutput] } as any);
	const output = createAssistantOutput();
	const deltas: string[] = [];
	const rawText = "Brief. citeturn0search2turn1view0";

	await processResponsesStream(
		asAsyncIterable([
			{ type: "response.created", response: { id: "resp_second" } },
			{ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_second" } },
			{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Brief. " },
			{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "ci" },
			{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "teturn0search2turn1view0" },
			{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "" },
			{ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_second", role: "assistant", status: "completed", content: [{ type: "output_text", text: rawText, annotations: [] }] } },
			{ type: "response.completed", response: { id: "resp_second", status: "completed", usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0 } } } },
		]),
		output,
		{
			push(event: any) {
				if (event.type === "text_delta") deltas.push(event.delta);
			},
		} as any,
		model,
		{ webSearchCitationSources: citationSources },
	);

	const expected = "Brief. ([example.com](https://example.com/source), [docs.example.org](https://docs.example.org/page))";
	assert.equal((output.content[0] as any).text, expected);
	assert.equal(deltas.join(""), expected);
	assert.doesNotMatch(deltas.join(""), /cite|turn0search2|turn1view0/);
	const replay = convertResponsesMessages(
		model,
		{ systemPrompt: "", tools: [], messages: [output] } as any,
		new Set(["openai"]),
		{ includeSystemPrompt: false },
	) as any[];
	assert.equal(replay[0].content[0].text, expected);
	assert.deepEqual(replay[0].content[0].annotations, []);
});

test("indexed source placeholders render from the latest assistant citation links", async () => {
	const firstOutput = createAssistantOutput();
	firstOutput.content.push({
		type: "text",
		text: "Prior answer ([example.com](https://example.com/source))",
	});
	const historicalCitationSources = collectHistoricalCitationSources(model, { messages: [firstOutput] } as any);
	const output = createAssistantOutput();
	const rawText = "Brief. 【0†source】";

	await processResponsesStream(
		asAsyncIterable([
			{ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_indexed", role: "assistant", status: "completed", content: [{ type: "output_text", text: rawText, annotations: [] }] } },
			{ type: "response.completed", response: { id: "resp_indexed", status: "completed", usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0 } } } },
		]),
		output,
		{ push() {} } as any,
		model,
		{ historicalCitationSources },
	);

	assert.equal((output.content[0] as any).text, "Brief. ([example.com](https://example.com/source))");
});

test("indexed source placeholders are removed when a Markdown link already follows", async () => {
	const output = createAssistantOutput();
	const rawText = "Brief. 【0†source】([example.com](https://example.com/source))";
	await processResponsesStream(
		asAsyncIterable([
			{ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_indexed_link", role: "assistant", status: "completed", content: [{ type: "output_text", text: rawText, annotations: [] }] } },
			{ type: "response.completed", response: { id: "resp_indexed_link", status: "completed", usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0 } } } },
		]),
		output,
		{ push() {} } as any,
		model,
		{ historicalCitationSources: [{ title: "Example", url: "https://example.com/source" }] },
	);

	assert.equal((output.content[0] as any).text, "Brief. ([example.com](https://example.com/source))");
});

test("literal internal citation examples inside Markdown code remain untouched", async () => {
	const output = createAssistantOutput();
	const rawText = "Literal `citeturn0search2`; actual citeturn0search2";
	await processResponsesStream(
		asAsyncIterable([
			{ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_literal", role: "assistant", status: "completed", content: [{ type: "output_text", text: rawText, annotations: [] }] } },
			{ type: "response.completed", response: { id: "resp_literal", status: "completed", usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0 } } } },
		]),
		output,
		{ push() {} } as any,
		model,
		{ webSearchCitationSources: [{ refId: "turn0search2", title: "First result", url: "https://example.com/source" }] },
	);

	assert.equal(
		(output.content[0] as any).text,
		"Literal `citeturn0search2`; actual ([example.com](https://example.com/source))",
	);
});
