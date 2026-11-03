import assert from "node:assert/strict";
import test from "node:test";
import { type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { convertResponsesMessages } from "../src/providers/responses/messages.js";

const model = getBuiltinModels("openai").find(model => model.id === "gpt-6-sol")!;
const user = (content: string): Context["messages"][number] => ({ role: "user", content, timestamp: 1 });
const assistant = (effort: string | undefined, overrides: Partial<AssistantMessage> = {}): AssistantMessage => ({
	role: "assistant", provider: model.provider, api: model.api, model: model.id,
	content: [{ type: "text", text: "reply" }], providerThinkingLevel: effort,
	stopReason: "stop", timestamp: 2,
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, ...overrides,
});
function convert(messages: Context["messages"], effort?: string): any[] {
	return convertResponsesMessages(model, { messages }, new Set([model.provider]), { configurationUpdateEffort: effort });
}
const efforts = (input: any[]) => input.filter(item => item.type === "configuration_update").map(item => item.reasoning.effort);

test("effort history is append-only across replies and skips unchanged selections", () => {
	const messages = [user("first"), assistant("low"), user("second"), assistant("low"), user("third")];
	const before = structuredClone(messages);
	const low = convert(messages, "low");
	assert.deepEqual(efforts(low), ["low"]);
	assert.deepEqual(efforts(convert(messages, "high")), ["low", "high"]);
	assert.deepEqual(convert(messages, "high").slice(0, low.length), low);
	assert.deepEqual(messages, before);
	assert.equal(low[0].role, "user");
	assert.equal(low[1].type, "configuration_update");
});

test("tool continuations and empty replies retain their established effort boundary", () => {
	const call = assistant("low", { stopReason: "toolUse", content: [{ type: "toolCall", id: "call|fc_call", name: "read", arguments: {} }] });
	const result = { role: "toolResult" as const, toolCallId: "call|fc_call", toolName: "read",
		content: [{ type: "text" as const, text: "result" }], isError: false, timestamp: 3 };
	const input = convert([user("first"), call, result], "high");
	assert.deepEqual(efforts(input), ["low", "high"]);
	assert.equal(input.at(-2).type, "function_call_output");
	assert.deepEqual(efforts(convert([user("first"), assistant("low", { content: [] }), user("next")], "low")), ["low"]);
});

test("foreign, failed and unrecorded assistants do not invent effort history; opt-out omits all updates", () => {
	const messages = [user("first"), assistant("high", { provider: "other" }), assistant("max", { stopReason: "error" }),
		assistant("xhigh", { stopReason: "aborted" }), assistant(undefined), user("next")];
	assert.deepEqual(efforts(convert(messages, "low")), ["low"]);
	assert.deepEqual(efforts(convert([user("first"), assistant("low"), user("next")], undefined)), []);
});
