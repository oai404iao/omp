import assert from "node:assert/strict";
import test from "node:test";
import { type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { resolveCodexRequestProfile } from "@oai404iao/pi-codex-runtime/internal/codex-request-profile";
import { type SessionWebSocketCacheEntry } from "@oai404iao/pi-codex-runtime/internal/providers/openai-codex/types";
import { buildRequestBody } from "../src/providers/openai-codex/request-body.js";
import { buildCachedWebSocketRequestBody } from "../src/providers/openai-codex/continuation.js";
import { configurationUpdateEffort } from "../src/providers/openai-codex/reasoning.js";
import { withCodexSettings } from "../../../tests/codex/support/provider-lifecycle-test-support.js";

const original = getBuiltinModels("openai").find(model => model.id === "gpt-6-sol")!;
const model = { ...original, compat: { ...original.compat, supportsMidConvoEffort: true } };
const user = (content: string): Context["messages"][number] => ({ role: "user", content, timestamp: 1 });
const reply: AssistantMessage & { providerThinkingLevel: string } = {
	role: "assistant", provider: model.provider, api: model.api, model: model.id, providerThinkingLevel: "low",
	content: [{ type: "text", text: "reply", textSignature: JSON.stringify({ id: "msg_reply" }) }], stopReason: "stop", timestamp: 2,
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
};

for (const responsesMode of ["standard", "lite"] as const) {
	test(`${responsesMode}: effort changes retain request baseline and WebSocket continuation prefix`, () =>
		withCodexSettings({}, async () => {
			const profile = resolveCodexRequestProfile({ responsesMode });
			const first = buildRequestBody(model, { messages: [user("first")] }, profile, { reasoning: "low", apiKey: "sk-fixture" });
			const history = [user("first"), reply, user("next")];
			const next = buildRequestBody(model, { messages: history }, profile, { reasoning: "high", apiKey: "sk-fixture" });
			const unchanged = buildRequestBody(model, { messages: history }, profile, { reasoning: "low", apiKey: "sk-fixture" });
			assert.equal(next.reasoning?.effort, "low");
			assert.equal(configurationUpdateEffort(next), "high");
			assert.deepEqual(next.input.slice(0, first.input.length), first.input);
			assert.equal(next.input.length, unchanged.input.length + 1);
			const replayedReply = next.input[first.input.length];
			const entry = { continuation: { lastRequestBody: first, lastResponseId: "resp_first", lastResponseItems: [replayedReply] } } as SessionWebSocketCacheEntry;
			const delta = buildCachedWebSocketRequestBody(entry, next);
			assert.equal(delta.previous_response_id, "resp_first");
			assert.deepEqual(delta.input, [next.input.at(-2), next.input.at(-1)]);
			assert.deepEqual(delta.input.at(-1), { type: "configuration_update", reasoning: { effort: "high" } });
		}));
}

test("capability opt-out and official ChatGPT auth keep request-level effort without configuration items", () =>
	withCodexSettings({}, async () => {
		const profile = resolveCodexRequestProfile();
		const optOut = { ...model, compat: { ...model.compat, supportsMidConvoEffort: false } };
		for (const [selected, apiKey] of [[optOut, "sk-fixture"],
			[model, "chatgpt-fixture"]] as const) {
			const body = buildRequestBody(selected, { messages: [user("first"), reply, user("next")] }, profile,
				{ apiKey, reasoning: "high" });
			assert.equal(configurationUpdateEffort(body), undefined);
			assert.equal(body.reasoning?.effort, "high");
		}
	}));

test("compacted/unrecorded context establishes a fresh baseline without rewriting older history", () =>
	withCodexSettings({}, async () => {
		const profile = resolveCodexRequestProfile();
		const legacy = { ...reply, providerThinkingLevel: undefined };
		const context = { messages: [legacy, user("next")] };
		const before = structuredClone(context);
		const body = buildRequestBody(model, context, profile, { reasoning: "high" });
		assert.equal(body.reasoning?.effort, "high");
		assert.equal(configurationUpdateEffort(body), "high");
		assert.deepEqual(context, before);
		const prewarm = buildRequestBody(model, { messages: [] }, profile, { reasoning: "high" });
		assert.equal(configurationUpdateEffort(prewarm), undefined);
	}));
