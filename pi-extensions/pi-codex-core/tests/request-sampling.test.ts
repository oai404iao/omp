import assert from "node:assert/strict";
import test from "node:test";
import type { Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { resolveCodexRequestProfile } from "@oai404iao/pi-codex-runtime/internal/codex-request-profile";
import { buildRequestBody } from "../src/providers/openai-codex/request-body.js";
import { withCodexSettings } from "../../../tests/codex/support/provider-lifecycle-test-support.js";

function model(): Model<"openai-responses"> {
	return {
		...getBuiltinModels("openai").find(model => model.id === "gpt-6-sol")!,
		thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "mapped-high", xhigh: null, max: null },
	};
}

function body(model: Model<"openai-responses">, options: SimpleStreamOptions = {}, lite = false) {
	return buildRequestBody(model, { systemPrompt: "RULE", messages: [], tools: [] },
		resolveCodexRequestProfile({ responsesMode: lite ? "lite" : "standard" }),
		{ apiKey: "sk-fixture", ...options });
}

test("sampling merges defaults, clamped Pi level and request keys before provider effort mapping", () =>
	withCodexSettings({}, async () => {
		const selected = {
			...model(),
			samplingParams: { temperature: 0.1, top_p: 0.2, typical_p: 0.3 },
			samplingParamsByThinkingLevel: {
				high: { temperature: 0.4, top_p: 0.5 },
				max: { temperature: 0.9 },
			},
		};
		const result = body(selected, { reasoning: "max", temperature: 0.6, samplingParams: { top_p: 0.7 } });
		assert.equal(result.reasoning?.effort, "mapped-high");
		assert.equal(result.temperature, 0.4);
		assert.equal(result.top_p, 0.7);
		assert.equal(result.typical_p, 0.3);
		assert.deepEqual(selected.samplingParams, { temperature: 0.1, top_p: 0.2, typical_p: 0.3 });
		assert.deepEqual(selected.samplingParamsByThinkingLevel.high, { temperature: 0.4, top_p: 0.5 });
		assert.equal(body(selected, { reasoning: "low" }).temperature, 0.1);
		assert.equal(body(selected, { reasoning: "high", samplingParams: { temperature: 0.8 } }).temperature, 0.8);
	}));

test("sampling uses native Off/non-reasoning clamps and leaves absent defaults unchanged", () =>
	withCodexSettings({}, async () => {
		const selected = {
			...model(), reasoning: false,
			samplingParamsByThinkingLevel: { off: { temperature: 0.25 }, high: { temperature: 0.75 } },
		};
		assert.equal(body(selected, { reasoning: "high" }).temperature, 0.25);
		assert.equal(body(selected).temperature, 0.25);
		assert.equal(body(model(), { temperature: 0.5 }).temperature, 0.5);
		assert.equal(body(model()).temperature, undefined);
		const noOff = { ...model(), thinkingLevelMap: { ...model().thinkingLevelMap, off: null },
			samplingParamsByThinkingLevel: { off: { temperature: 0.1 }, low: { temperature: 0.3 } } };
		assert.equal(body(noOff).temperature, 0.3);
	}));

test("sampling cannot replace structural, capability, auth or transport fields", () =>
	withCodexSettings({}, async () => {
		const selected = model();
		const original = body(selected, { reasoning: "high", sessionId: "sampling-contract" });
		const result = body(selected, {
			reasoning: "high", sessionId: "sampling-contract",
			samplingParams: {
				model: "other", input: [], instructions: "replace", prompt: { id: "foreign" }, tools: [{ type: "web_search" }],
				tool_choice: "required", parallel_tool_calls: false, reasoning: { context: "all_turns" },
				reasoning_effort: "max", text: { verbosity: "high" }, store: true, stream: false,
				include: [], service_tier: "priority", prompt_cache_key: "foreign",
				prompt_cache_retention: "24h", prompt_cache_options: {}, metadata: { secret: true },
				client_metadata: { spoof: true }, previous_response_id: "old", generate: false,
				background: true, conversation: "foreign", context_management: [], max_tokens: 64, max_completion_tokens: 64,
				additional_tools: [], compaction_trigger: true, headers: { authorization: "secret" },
				apiKey: "other", baseUrl: "https://other.invalid", transport: "websocket",
				session_id: "other", "x-codex-feature": true, constructor: "replace", typical_p: 0.6,
			},
		});
		assert.deepEqual(result, { ...original, typical_p: 0.6 });
	}));

test("sampling token caps obey API-key compatibility, precedence and finite positive limits", () =>
	withCodexSettings({}, async () => {
		const selected = { ...model(), samplingParams: { max_output_tokens: 40 } };
		assert.equal(body(selected, { maxTokens: 32 }).max_output_tokens, 40);
		assert.equal(body(selected, { maxTokens: 32, samplingParams: { max_output_tokens: 64 } }).max_output_tokens, 64);
		assert.equal(body(selected, { samplingParams: { max_output_tokens: 1 } }).max_output_tokens, 16);
		for (const value of [0, -1, NaN, Infinity, "64", null]) {
			assert.equal(body(selected, { maxTokens: 32, samplingParams: { max_output_tokens: value } }).max_output_tokens, 32);
		}
		const disabled = { ...selected, compat: { ...selected.compat, supportsMaxOutputTokens: false } };
		assert.equal(body(disabled, { maxTokens: 32 }).max_output_tokens, undefined);
	}));

test("ChatGPT omits unsupported sampling fields only on Pi's native URL/token boundary", () =>
	withCodexSettings({}, async () => {
		const selected = { ...model(), samplingParams: { temperature: 0.4, max_output_tokens: 64, typical_p: 0.8 } };
		const subscription = body(selected, { apiKey: "chatgpt-fixture", temperature: 0.2, maxTokens: 32,
			samplingParams: { temperature: 0.6, max_output_tokens: 128 } });
		assert.equal(subscription.temperature, undefined);
		assert.equal(subscription.max_output_tokens, undefined);
		assert.equal(subscription.typical_p, 0.8);
		for (const [override, auth] of [
			[{ baseUrl: "https://proxy.invalid/v1" }, { apiKey: "chatgpt-fixture" }],
			[{}, { apiKey: undefined, headers: { authorization: "Bearer header-only" } }],
		] as const) {
			const result = body({ ...selected, ...override }, auth);
			assert.equal(result.temperature, 0.4);
			assert.equal(result.max_output_tokens, 64);
		}
	}));

test("Lite merges only temperature without changing its reviewed envelope", () =>
	withCodexSettings({}, async () => {
		const selected = { ...model(), samplingParams: { temperature: 0.1, typical_p: 0.2, max_output_tokens: 64 },
			samplingParamsByThinkingLevel: { high: { temperature: 0.3, top_p: 0.4 } } };
		const result = body(selected, { reasoning: "max", maxTokens: 32, temperature: 0.5,
			samplingParams: { temperature: 0.6, tools: [], reasoning: { context: "current_turn" } } }, true);
		assert.equal(result.temperature, 0.6);
		assert.equal(result.typical_p, undefined);
		assert.equal(result.top_p, undefined);
		assert.equal(result.max_output_tokens, undefined);
		assert.equal(result.tools, undefined);
		assert.equal(result.reasoning?.context, "all_turns");
		assert.equal(result.parallel_tool_calls, false);
		assert.equal(body(selected, { apiKey: "chatgpt-fixture", reasoning: "high" }, true).temperature, undefined);
	}));

test("legacy Codex keeps named temperature without adopting OpenAI sampling overrides", () =>
	withCodexSettings({}, async () => {
		const legacy = { ...model(), provider: "openai-codex", api: "openai-codex-responses",
			samplingParams: { temperature: 0.4, typical_p: 0.5, max_output_tokens: 64 } };
		const result = buildRequestBody(legacy as Model<"openai-codex-responses">, { messages: [] },
			resolveCodexRequestProfile(), { temperature: 0.2, maxTokens: 32, samplingParams: { temperature: 0.8 } });
		assert.equal(result.temperature, 0.2);
		assert.equal(result.typical_p, undefined);
		assert.equal(result.max_output_tokens, undefined);
	}));
