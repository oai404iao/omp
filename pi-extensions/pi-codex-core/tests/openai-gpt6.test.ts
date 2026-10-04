import assert from "node:assert/strict";
import test from "node:test";
import { clampThinkingLevel, type AssistantMessage, type Model, type Tool } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { buildRequestBody, requestBodyToolOptions } from "../src/providers/openai-codex/request-body.js";
import { createApplyPatchToolDefinition } from "../src/tools/apply-patch.js";
import { resolveCodexRequestProfile } from "@oai404iao/pi-codex-runtime/internal/codex-request-profile";
import { computeToolCapabilities } from "@oai404iao/pi-codex-runtime/internal/capabilities";
import { loadModelSettings } from "@oai404iao/pi-codex-runtime/internal/model-catalog/runtime";
import { withCodexSettings } from "../../../tests/codex/support/provider-lifecycle-test-support.js";
import { createProviderHarness } from "./support/openai-codex-test-support.js";
import { DEFAULT_SETTINGS } from "@oai404iao/pi-codex-runtime/internal/settings";

for (const id of ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]) {
	test(`${id}: Pi-evidenced Standard profile with only local patch/image-view capabilities`, () =>
		withCodexSettings({}, async cwd => {
			const model: Model<"openai-responses"> | undefined = getBuiltinModels("openai").find(model => model.id === id);
			assert(model, "Pi must supply the descriptor");
			assert.equal(model.type, "chat");
			assert.equal(model.api, "openai-responses");
			assert.equal(model.baseUrl, "https://api.openai.com/v1");
			assert.deepEqual(model.input, ["text", "image"]);
			assert.equal(model.contextWindow, 272000);
			assert.equal(model.maxTokens, 128000);
			const off = id === "gpt-6-astra" ? null : "none";
			assert.deepEqual(model.thinkingLevelMap, { off, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
			assert.equal(clampThinkingLevel(model, "off"), off === null ? "low" : "off");
			assert.equal(model.compat?.supportsOpenAIGrammarTools, true);
			const settings = loadModelSettings(model, cwd);
			assert.equal(settings.requestProfile.responsesMode, "standard");
			assert.equal(settings.responsesEndpoint, "openai");
			assert.equal(settings.openaiTransport, "sse");
			assert.equal(settings.openaiWebSocketPrewarm, false);
			assert.equal(settings.compactionMode, "pi");
			assert.equal(settings.fastServiceTier, undefined);
			assert.equal(settings.webSearchImplementation, undefined);
			assert.equal(settings.imageGenerationImplementation, undefined);
			const capabilities = computeToolCapabilities(model, DEFAULT_SETTINGS);
			assert.equal(capabilities.apply_patch.enabled, true);
			assert.equal(capabilities.view_image.enabled, true);
			assert.equal(capabilities.web_search.enabled, false);
			assert.equal(capabilities.image_generation.enabled, false);
			for (const reasoning of [undefined, "minimal", "low", "max"] as const) {
				const body: ReturnType<typeof buildRequestBody> = buildRequestBody(model, {
					systemPrompt: "RULE", messages: [{ role: "user", content: "hello", timestamp: 1 }],
					tools: [createApplyPatchToolDefinition() as unknown as Tool],
				}, resolveCodexRequestProfile(settings.requestProfile), {
					...requestBodyToolOptions(settings), reasoning, ownsNativeTool: () => true,
				});
				const effort: string | undefined = reasoning === undefined ? off ?? undefined
					: model.thinkingLevelMap?.[clampThinkingLevel(model, reasoning)] ?? undefined;
				assert.equal(body.reasoning?.effort, effort);
				assert.equal(body.reasoning?.context, undefined);
				assert.equal(body.instructions, "RULE");
				assert.equal(body.parallel_tool_calls, true);
				assert.equal((body.tools?.[0] as { type?: string })?.type, "custom");
				assert(!body.input.some(item => (item as { type?: string }).type === "additional_tools"));
			}
			assert.equal(loadModelSettings({ ...model, id: `${id}-unknown` }, cwd).providerShimActive, false);
		}));

	test(`${id}: wire-off Standard requests honor Pi OAuth/API-key fields without enabling remote tools`, () =>
		withCodexSettings({ codexRequestExtensions: false }, async cwd => {
			const model: Model<"openai-responses"> | undefined = getBuiltinModels("openai").find(model => model.id === id);
			assert(model);
			const harness = createProviderHarness({ cwd });
			for (const apiKey of ["sk-fixture", "chatgpt-fixture"]) {
				let requests = 0;
				const message: AssistantMessage = await harness.providers.openai.streamSimple(model, {
					messages: [{ role: "user", content: "fixture", timestamp: 1 }], tools: [createApplyPatchToolDefinition()],
				}, {
					apiKey, sessionId: `native-${id}`, temperature: 0.2, maxTokens: 32, reasoning: "max",
					fetch: async (url: unknown, init?: RequestInit) => {
						requests++;
						assert.equal(String(url), "https://api.openai.com/v1/responses");
						const headers = new Headers(init?.headers);
						assert.equal(headers.get("authorization"), `Bearer ${apiKey}`);
						assert.equal(headers.get("chatgpt-account-id"), null);
						assert.equal(headers.get("x-openai-internal-codex-responses-lite"), null);
						const body = JSON.parse(String(init?.body));
						assert.equal(body.client_metadata, undefined);
						assert.equal(body.reasoning.effort, "max");
						assert.equal(body.max_output_tokens, apiKey.startsWith("sk-") ? 32 : undefined);
						assert.equal(body.temperature, apiKey.startsWith("sk-") ? 0.2 : undefined);
						assert.deepEqual(body.tools.map((tool: { type: string; name: string }) => [tool.type, tool.name]), [["custom", "apply_patch"]]);
						return new Response(`data: ${JSON.stringify({ type: "response.completed", response: {
							id: "fixture", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 },
						} })}\n\n`);
					},
				}).result();
				assert.equal(message.stopReason, "stop", message.errorMessage ?? "");
				assert.equal(requests, 1);
			}
		}));
}

test("GPT-6.1 Sol defaults match the GPT-5.6 Sol Lite capabilities without replacing Pi metadata", () =>
	withCodexSettings({}, async cwd => {
		const model = getBuiltinModels("openai").find(model => model.id === "gpt-6.1-sol");
		assert(model);
		assert.equal(model.api, "openai-responses");
		assert.equal(model.baseUrl, "https://api.openai.com/v1");
		assert.equal(model.contextWindow, 272000);
		assert.equal(model.maxTokens, 128000);
		assert.deepEqual(model.input, ["text", "image"]);
		const settings = loadModelSettings(model, cwd);
		const previous = loadModelSettings({ ...model, id: "gpt-5.6-sol" }, cwd);
		assert.deepEqual(settings.modelProfile?.effective, previous.modelProfile?.effective);
		assert.equal(settings.requestProfile.responsesMode, "lite");
		assert.equal(settings.openaiTransport, "auto");
		assert.equal(settings.openaiWebSocketPrewarm, true);
		assert.equal(settings.compactionMode, "responses");
		assert.equal(settings.fastServiceTier, "priority");
		assert.equal(settings.modelProfile?.effective.fast && settings.modelProfile.effective.fast.costMultiplier, 2);
		const capabilities = computeToolCapabilities(model, DEFAULT_SETTINGS);
		assert.equal(capabilities.apply_patch.enabled, true);
		assert.equal(capabilities.view_image.enabled, false);
		assert.equal(capabilities.web_search.enabled, true);
		assert.equal(capabilities.image_generation.enabled, true);
		assert.equal(settings.webSearchImplementation, "standalone");
		assert.equal(settings.imageGenerationImplementation, "standalone");
		assert.equal(loadModelSettings({ ...model, id: "gpt-6.1-sol-unknown" }, cwd).providerShimActive, false);
		assert.equal(loadModelSettings({ ...model, provider: "openai-codex" }, cwd).providerShimActive, false);
	}));

test("GPT-6.1 Sol Lite custom patch calls decode and replay on the default enhanced wire", () =>
	withCodexSettings({}, async cwd => {
		const model: Model<"openai-responses"> | undefined = getBuiltinModels("openai").find(model => model.id === "gpt-6.1-sol");
		assert(model);
		const harness = createProviderHarness({ cwd });
		const tools = [createApplyPatchToolDefinition()];
		const patch = "*** Begin Patch\n*** Add File: fixture.txt\n+fixture\n*** End Patch";
		const item = { type: "custom_tool_call", id: "ct_fixture", call_id: "call_fixture", name: "apply_patch", input: patch };
		let requests = 0;
		const fetch = async (url: unknown, init?: RequestInit) => {
			requests++;
			assert.equal(String(url), "https://api.openai.com/v1/responses");
			assert.equal(new Headers(init?.headers).get("x-openai-internal-codex-responses-lite"), "true");
			const body = JSON.parse(String(init?.body));
			assert(body.client_metadata);
			assert.equal(body.tools, undefined);
			assert.equal(body.input[0].type, "additional_tools");
			assert.equal(body.input[0].tools[0].tools[0].type, "custom");
			assert.equal(body.parallel_tool_calls, false);
			assert.equal(body.reasoning.context, "all_turns");
			if (requests === 2) {
				assert(body.input.some((entry: any) => entry.type === "custom_tool_call" && entry.input === patch));
				assert(body.input.some((entry: any) => entry.type === "custom_tool_call_output" && entry.output === "fixture result"));
			}
			const events = requests === 1 ? [
				{ type: "response.output_item.added", output_index: 0, item: { ...item, input: "" } },
				{ type: "response.custom_tool_call_input.delta", output_index: 0, delta: patch },
				{ type: "response.output_item.done", output_index: 0, item },
			] : [];
			events.push({ type: "response.completed", response: {
				id: `fixture-${requests}`, status: "completed", output: requests === 1 ? [item] : [],
				usage: { input_tokens: 1, output_tokens: 1 },
			} } as any);
			return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
		};
		const options = { apiKey: "sk-fixture", sessionId: "new-openai-roundtrip", transport: "sse", fetch, maxRetries: 0 };
		const user = { role: "user", content: "fixture", timestamp: 1 };
		const first: AssistantMessage = await harness.providers.openai.streamSimple(model, { messages: [user], tools }, options).result();
		assert.equal(first.stopReason, "toolUse", first.errorMessage ?? "");
		const call = first.content.find(block => block.type === "toolCall");
		assert(call?.type === "toolCall");
		assert.deepEqual(call.arguments, { input: patch });
		const second: AssistantMessage = await harness.providers.openai.streamSimple(model, { tools, messages: [
			user, first, { role: "toolResult", toolName: "apply_patch", toolCallId: call.id,
				content: [{ type: "text", text: "fixture result" }], isError: false, timestamp: 2 },
		] }, options).result();
		assert.equal(second.stopReason, "stop", second.errorMessage ?? "");
		assert.equal(requests, 2);
	}));
