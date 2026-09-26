import assert from "node:assert/strict";
import { test } from "node:test";
import type { Context, Tool, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { convertResponsesTools } from "@oai404iao/pi-codex-runtime/internal/providers/responses/tools";
import { convertResponsesMessages } from "@oai404iao/pi-codex-runtime/internal/providers/responses/messages";
import { processResponsesStream } from "@oai404iao/pi-codex-runtime/internal/providers/responses/stream";
import { responseGrammarProperties } from "@oai404iao/pi-codex-runtime/internal/providers/responses/grammar";
import { captureContext, responsesModel, withCodexSettings } from "../../../tests/codex/support/provider-lifecycle-test-support.js";
import { createProviderHarness } from "./support/openai-codex-test-support.js";
import { startWebSocketServer, successEvents } from "./support/websocket-test-support.js";
import { closeProviderWebSocketSessions } from "@oai404iao/pi-codex-core/internal/providers/openai-codex/websocket-session";
import { resolveGrammarSampling, grammarInputDelta } from "@oai404iao/pi-codex-runtime/internal/providers/responses/sampling";
import { resolveGrammarConstrainedSampling } from "@earendil-works/pi-ai/api/constrained-sampling";

const tool: Tool = {
	name: "arbitrary_script", description: "Generic grammar fixture, not Code Mode",
	parameters: { type: "object", properties: { source: { type: "string" } }, required: ["source"] } as Tool["parameters"],
	constrainedSampling: { type: "grammar", variants: { openai_lark: "start: /[\\s\\S]+/" } },
};
const input = 'print("😀 \\"quoted\\"");\nnext();';
function customEvents(namespace?: string, source = input): unknown[] {
	const item = { type: "custom_tool_call", id: "ctc_generic", call_id: "call_generic", name: tool.name,
		...(namespace ? { namespace } : {}), input: source };
	return [
		{ type: "response.created", response: { id: "resp_grammar" } },
		{ type: "response.output_item.added", output_index: 0, item: { ...item, input: "" } },
		{ type: "response.custom_tool_call_input.delta", item_id: item.id, delta: source.slice(0, 7) },
		{ type: "response.custom_tool_call_input.delta", item_id: item.id, delta: source.slice(7) },
		{ type: "response.custom_tool_call_input.done", item_id: item.id, input: source },
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.completed", response: { id: "resp_grammar", status: "completed", output: [item],
			usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
	];
}
async function* events(values: unknown[]) { for (const value of values) yield value as never; }

test("neutral grammar: local sampling adapter agrees with pinned Pi and preserves arbitrary split Unicode", () => {
	for (const variants of [{ openai_lark: "start: /.+/" }, { openai_regex: ".+" }, { openai_lark: "x", openai_regex: "y" }]) {
		const candidate: Tool = { ...tool, constrainedSampling: { type: "grammar", variants } };
		assert.deepEqual(resolveGrammarSampling(candidate, true), resolveGrammarConstrainedSampling(candidate, true));
		assert.equal(resolveGrammarSampling(candidate, false), undefined);
	}
	const source = '\ud83d\ude00\n\t"\\\r\ud800 tail';
	for (let split = 0; split <= source.length; split++) {
		const buffer = { input: "", started: false, closed: false };
		const wire = (grammarInputDelta(buffer, "strange\"key", source.slice(0, split), false) ?? "")
			+ (grammarInputDelta(buffer, "strange\"key", source, true) ?? "");
		assert.deepEqual(JSON.parse(wire), { 'strange"key': source });
		assert.equal(grammarInputDelta(buffer, "strange\"key", source, true), undefined);
	}
});

test("neutral grammar: outbound tools and Lite namespaces infer the schema's own input property", () => {
	const json = convertResponsesTools([tool]);
	assert.equal(json[0].type, "function");
	const custom = convertResponsesTools([tool], { supportsOpenAIGrammarTools: true });
	assert.equal(custom[0].type, "custom");
	assert.equal(responseGrammarProperties({ tools: custom }, [tool]).get(tool.name), "source");
	assert.equal(responseGrammarProperties({ input: [{ type: "additional_tools", tools: [{ type: "namespace", name: "functions", tools: custom }] }] }, [tool]).get(tool.name), "source");
	assert.equal(responseGrammarProperties({ tools: json }, [tool]).size, 0);
	assert.throws(() => convertResponsesTools([{ ...tool, parameters: { type: "object", properties: {}, required: [] } as Tool["parameters"] }],
		{ supportsOpenAIGrammarTools: true }), /grammar/);
});

test("neutral grammar: streamed raw text produces escaped JSON deltas and canonical arguments", async () => {
	const c = captureContext();
	await processResponsesStream(events(customEvents("functions")), c.output, c.stream, responsesModel, {
		grammarToolInputProperties: new Map([[tool.name, "source"]]),
	});
	const call = c.output.content.find((block) => block.type === "toolCall");
	assert(call?.type === "toolCall");
	assert.deepEqual(call.arguments, { source: input });
	assert(!("partialInput" in call));
	const deltas = c.events.filter((event): event is Extract<AssistantMessageEvent, { type: "toolcall_delta" }> => event.type === "toolcall_delta");
	assert.deepEqual(JSON.parse(deltas.map((event) => event.delta).join("")), { source: input });
	assert.equal(c.output.stopReason, "toolUse");
});

test("neutral grammar: done-only calls map correctly; rewritten finalized inputs fail closed", async () => {
	const c = captureContext();
	const full = customEvents();
	await processResponsesStream(events(full.slice(-2)), c.output, c.stream, responsesModel, { grammarToolInputProperties: new Map([[tool.name, "source"]]) });
	const call = c.output.content.find((block) => block.type === "toolCall");
	assert(call?.type === "toolCall");
	assert.deepEqual(call.arguments, { source: input });
	const bad = customEvents();
	(bad[5] as { item: { input: string } }).item.input = "different after done";
	const second = captureContext();
	await assert.rejects(processResponsesStream(events(bad), second.output, second.stream, responsesModel,
		{ grammarToolInputProperties: new Map([[tool.name, "source"]]) }), /closed|monotonic/);
});

test("neutral grammar: JSON/custom replay switches both call and result without changing saved history", async () => {
	const c = captureContext();
	await processResponsesStream(events(customEvents()), c.output, c.stream, responsesModel, {
		grammarToolInputProperties: new Map([[tool.name, "source"]]),
	});
	const context: Context = { tools: [tool], messages: [c.output, {
		role: "toolResult", toolCallId: "call_generic|ctc_generic", toolName: tool.name,
		content: [{ type: "text", text: "ok" }], isError: false, timestamp: 1,
	}] };
	const saved = structuredClone(context);
	const custom = convertResponsesMessages(responsesModel, context, new Set(["openai"]),
		{ grammarToolInputProperties: new Map([[tool.name, "source"]]) }) as unknown as Array<Record<string, unknown>>;
	assert.equal(custom[0].type, "custom_tool_call");
	assert.equal(custom[0].input, input);
	assert.equal(custom[1].type, "custom_tool_call_output");
	const json = convertResponsesMessages(responsesModel, context, new Set(["openai"]),
		{ grammarToolInputProperties: new Map() }) as unknown as Array<Record<string, unknown>>;
	assert.equal(json[0].type, "function_call");
	assert.equal(json[0].id, undefined);
	assert.deepEqual(JSON.parse(String(json[0].arguments)), { source: input });
	assert.equal(json[1].type, "function_call_output");
	assert.deepEqual(context, saved);
	const inputTool = { ...tool, constrainedSampling: false as const };
	const inputContext = structuredClone(context);
	inputContext.tools = [inputTool];
	const call = inputContext.messages[0];
	assert(call.role === "assistant" && call.content[0].type === "toolCall");
	call.content[0].arguments = { input };
	const changed = convertResponsesMessages(responsesModel, inputContext, new Set(["openai"]),
		{ grammarToolInputProperties: new Map() }) as unknown as Array<Record<string, unknown>>;
	assert.equal(changed[0].type, "function_call", "input-named generic grammar also downgrades; no exec-specific branch");
});

for (const lite of [false, true]) test(`neutral grammar: real loopback WebSocket ${lite ? "Lite" : "Standard"} continuation and JSON downgrade`, async () => {
	await withCodexSettings({ enabled: true, openaiTransport: "websocket-cached", openaiWebSocketPrewarm: false }, async () => {
		const server = await startWebSocketServer([
			() => customEvents(lite ? "functions" : undefined),
			() => successEvents("resp_next", "next"),
			() => successEvents("resp_json", "JSON"),
		]);
		const sessionId = `grammar-${lite ? "lite" : "standard"}`;
		const harness = createProviderHarness();
		const model = { ...responsesModel, id: lite ? "gpt-5.6-sol" : "gpt-5.5", baseUrl: server.url,
			compat: { supportsOpenAIGrammarTools: true } };
		const options = { apiKey: "fixture-not-real", sessionId };
		try {
			const initial: Context = { systemPrompt: "fixture", tools: [tool], messages: [{ role: "user", content: "run", timestamp: 1 }] };
			const first = await harness.providers.openai.streamSimple(model, initial, options).result();
			assert.equal(first.stopReason, "toolUse", first.errorMessage);
			assert.deepEqual(first.content.find((block: { type: string }) => block.type === "toolCall").arguments, { source: input });
			const context: Context = { ...initial, messages: [...initial.messages, first, {
				role: "toolResult", toolCallId: "call_generic|ctc_generic", toolName: tool.name,
				content: [{ type: "text", text: "ok" }], isError: false, timestamp: 2,
			}] };
			const next = await harness.providers.openai.streamSimple(model, context, options).result();
			assert.equal(next.stopReason, "stop", next.errorMessage);
			assert.equal(server.requests[1].previous_response_id, "resp_grammar");
			assert.equal(server.requests[1].input[0].type, "custom_tool_call_output");
			const jsonModel = { ...model, compat: { supportsOpenAIGrammarTools: false } };
			const last = await harness.providers.openai.streamSimple(jsonModel, { ...context, messages: [...context.messages, next] }, options).result();
			assert.equal(last.stopReason, "stop", last.errorMessage);
			assert.equal(server.requests[2].previous_response_id, undefined, "changed tool envelope must not reuse a non-equivalent prefix");
			const replay = server.requests[2].input.find((item: { type: string; name?: string }) => item.type === "function_call" && item.name === tool.name);
			assert.deepEqual(JSON.parse(replay.arguments), { source: input });
			assert(server.requests[2].input.some((item: { type: string }) => item.type === "function_call_output"));
		} finally {
			closeProviderWebSocketSessions(sessionId);
			await server.close();
		}
	});
});
