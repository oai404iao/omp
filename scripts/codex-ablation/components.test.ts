import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { resolveCodexRequestProfile } from "@oai404iao/pi-codex-runtime/internal/codex-request-profile";
import { convertResponsesMessages } from "@oai404iao/pi-codex-runtime/internal/providers/responses/messages";
import { buildRequestBody } from "@oai404iao/pi-codex-core/internal/providers/openai-codex/request-body";
import { buildCachedWebSocketRequestBody } from "@oai404iao/pi-codex-core/internal/providers/openai-codex/continuation";
import { createInitialAssistantMessage } from "@oai404iao/pi-codex-core/internal/providers/openai-codex/message";
import { processCapturedResponsesStream } from "@oai404iao/pi-codex-core/internal/providers/openai-codex/captured-stream";
import { processResponsesStream } from "@oai404iao/pi-codex-runtime/internal/providers/responses/stream";
import { createWebSearchCapture } from "@oai404iao/pi-codex-tools/internal/tools/web-search/capture";
import { context, iterable, model, terminal, textEvents, textItem } from "./fixtures.js";

const patchTool = {
	name: "apply_patch", description: "Apply a patch.",
	parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] },
};
const baseProfile = resolveCodexRequestProfile({ patchTransport: "custom" });
const requestContext = { ...context, tools: [patchTool] };
const body = (override = {}) => buildRequestBody(
	model, structuredClone(requestContext), { ...baseProfile, ...override }, { reasoning: "low" },
) as any;

test("A4 remove exact replay signature: text survives, identity and annotations do not", () => {
	const item = { ...structuredClone(textItem), content: [{
		type: "output_text", text: "你好 🌍",
		annotations: [{ type: "url_citation", start_index: 0, end_index: 2, title: "Fixture", url: "https://example.invalid/" }],
	}] };
	const message = createInitialAssistantMessage(model);
	message.content = [{ type: "text", text: "你好 🌍", textSignature: JSON.stringify({ v: 2, item }) }];
	const fullContext = { ...context, messages: [message] };
	const saved = structuredClone(fullContext);
	const ablatedContext = structuredClone(fullContext);
	delete (ablatedContext.messages[0].content[0] as any).textSignature;
	const convert = (value: any) => convertResponsesMessages(model, value, new Set(["openai-codex"]), { includeSystemPrompt: false }) as any[];
	const full = convert(fullContext);
	const ablated = convert(ablatedContext);
	assert.deepEqual(full, [item]);
	assert.equal(ablated[0].content[0].text, item.content[0].text);
	assert.deepEqual(ablated[0].content[0].annotations, []);
	assert.notEqual(ablated[0].id, item.id);
	assert.equal(ablated[0].phase, undefined);
	assert.deepEqual(fullContext, saved, "saved history must not be mutated");
});

test("A5 remove WS continuation cache: full history replaces the proved suffix", (t) => {
	const prior = body();
	const nextUser = { role: "user", content: [{ type: "input_text", text: "continue" }] };
	const next = { ...prior, input: [...prior.input, textItem, nextUser] };
	const entry = () => ({ continuation: {
		lastRequestBody: structuredClone(prior), lastResponseId: "resp_fixture", lastResponseItems: [structuredClone(textItem)],
	} }) as any;
	const full = buildCachedWebSocketRequestBody(entry(), next) as any;
	const ablated = buildCachedWebSocketRequestBody({} as any, next);
	assert.equal(full.previous_response_id, "resp_fixture");
	assert.deepEqual(full.input, [nextUser]);
	assert.deepEqual(ablated, next);
	for (const changed of [
		{ ...next, temperature: 0.5 },
		{ ...next, input: [{ role: "user", content: "different prefix" }, textItem, nextUser] },
	]) {
		const cache = entry();
		assert.deepEqual(buildCachedWebSocketRequestBody(cache, changed), changed);
		assert.equal(cache.continuation, undefined);
	}
	t.diagnostic(`input items: continuation=${full.input.length}; cache removed=${ablated.input.length}; pure request planning, not latency/cache-hit evidence`);
});

test("A6 remove web observer: presentation changes, captured wire items stay identical", async () => {
	const searchItem = {
		type: "web_search_call", id: "ws_fixture", status: "completed",
		action: { type: "search", query: "pi docs" },
	};
	const events = [
		{ type: "response.output_item.done", output_index: 0, item: searchItem },
		...textEvents().filter((event) => event.type !== "response.created").map((event) => (
			"output_index" in event ? { ...event, output_index: 1 } : event
		)),
	];
	const process = async (observer: boolean) => {
		const output = createInitialAssistantMessage(model);
		const stream = createAssistantMessageEventStream();
		const capture = await processCapturedResponsesStream(
			iterable(events), output, stream, model, undefined, undefined,
			observer ? { createEventObserver: createWebSearchCapture } : {},
			"/offline-fixture", "pi docs", [], [],
		);
		stream.end();
		return { output, capture };
	};
	const full = await process(true);
	const ablated = await process(false);
	assert.deepEqual(full.capture, ablated.capture);
	assert.equal(full.capture.responseItems.length, 2);
	assert.equal(ablated.output.content.length, 1);
	assert.equal(full.output.content.length, 2);
	assert.match((full.output.content[0] as any).text, /Searched the web/);
	assert.deepEqual(full.output.content[1], ablated.output.content[0]);
	assert.deepEqual(full.output.usage, ablated.output.usage);
});

test("A7 bypass normalization: compaction content survives but continuation capture loses the item", async () => {
	const compaction = { type: "compaction", id: "cmp_fixture", encrypted_content: "opaque-fixture" };
	const events = [terminal({ output: [compaction] })];
	const full = createInitialAssistantMessage(model);
	const ablated = createInitialAssistantMessage(model);
	const fullStream = createAssistantMessageEventStream();
	const ablatedStream = createAssistantMessageEventStream();
	const capture = await processCapturedResponsesStream(
		iterable(events), full, fullStream, model, undefined, undefined, {}, "/offline-fixture", undefined, [], [],
	);
	const rawItems: unknown[] = [];
	async function* unnormalized() {
		for await (const event of iterable(events)) {
			if (event.type === "response.output_item.done") rawItems.push(event.item);
			yield event;
		}
	}
	await processResponsesStream(unnormalized(), ablated, ablatedStream, model);
	fullStream.end();
	ablatedStream.end();
	assert.deepEqual(capture.responseItems, [compaction]);
	assert.deepEqual(rawItems, []);
	assert.equal(full.content.length, 1);
	assert.deepEqual(full.content, ablated.content);
	assert.deepEqual(full.usage, ablated.usage);
});
