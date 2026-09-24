import assert from "node:assert/strict";
import { test } from "node:test";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { Model } from "@earendil-works/pi-ai";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { buildRequestBody } from "@oai404iao/pi-codex-core/internal/providers/openai-codex/request-body";
import { resolveCodexRequestProfile } from "@oai404iao/pi-codex-runtime/internal/codex-request-profile";
import { loadModelSettings } from "@oai404iao/pi-codex-runtime/internal/model-catalog/runtime";
import { withCodexSettings } from "../../../tests/codex/support/provider-lifecycle-test-support.js";

for (const id of ["gpt-6-sol", "gpt-6-luna"]) {
	test(`${id}: exact descriptor and evidence-backed Lite profile`, () => withCodexSettings({}, async (cwd) => {
		const actual = getBuiltinModels("openai-codex").find((model) => model.id === id);
		if (VERSION === "0.87.1") assert(actual, "target Pi must supply the new descriptor");
		// The floor predates these catalog entries; exercise the same wire
		// contract without injecting a model into the host registry.
		const model = actual ?? {
			id, name: id, provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://fixture.invalid",
			reasoning: true, input: ["text", "image"], contextWindow: 272000, maxTokens: 128000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			thinkingLevelMap: { off: "none", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
			compat: { supportsOpenAIGrammarTools: true, supportsAdditionalTools: true },
		} satisfies Model<"openai-codex-responses">;
		assert.deepEqual(model.input, ["text", "image"]);
		assert.equal(model.contextWindow, 272000);
		assert.equal(model.maxTokens, 128000);
		assert.equal(model.thinkingLevelMap?.off, "none");
		assert.equal(model.thinkingLevelMap?.max, "max");
		assert.equal(model.compat?.supportsOpenAIGrammarTools, true);
		const settings = loadModelSettings(model, cwd);
		assert.equal(settings.compactionMode, "responses");
		assert.equal(settings.openaiTransport, "auto");
		assert.equal(settings.openaiWebSocketPrewarm, true);
		assert.equal(settings.modelProfile?.effective.fast, false);
		const tools = ["apply_patch", "web_search", "image_generation"].map((name) => ({
			name, description: name, parameters: { type: "object", properties: { input: { type: "string" } } },
		}));
		for (const reasoning of [undefined, "minimal", "max"] as const) {
			const body = buildRequestBody(model, {
				systemPrompt: "RULE", messages: [{ role: "user", content: "hello", timestamp: 1 }], tools,
			}, resolveCodexRequestProfile(settings.requestProfile), {
				reasoning, ownsNativeTool: () => true, imageGeneration: settings.imageGenerationImplementation ?? false,
			});
			assert.deepEqual(body.reasoning, { context: "all_turns", effort: reasoning === undefined ? "none" : reasoning === "minimal" ? "low" : "max" });
			assert.equal(body.parallel_tool_calls, false);
			assert.equal(body.tools, undefined);
			assert.equal(body.instructions, undefined);
			assert.equal(body.prompt_cache_retention, undefined);
			assert.equal(body.prompt_cache_options, undefined);
			const declarations = body.input[0] as any;
			assert.equal(declarations.type, "additional_tools");
			assert.deepEqual(declarations.tools.map((tool: any) => tool.name), ["functions", "web", "image_gen"]);
			assert.equal(declarations.tools[0].tools[0].type, "custom");
			assert.equal((body.input[1] as any).role, "developer");
		}
		assert.equal(loadModelSettings({ ...model, provider: "openai" }, cwd).modelProfile?.effective.enabled ?? false, false);
		assert.equal(loadModelSettings({ ...model, id: `${id}-unknown` }, cwd).modelProfile?.effective.enabled ?? false, false);
	}));

	test(`${id}: global image kill switch remains authoritative`, () => withCodexSettings({ imageGeneration: false }, async (cwd) => {
		const model = { provider: "openai-codex", api: "openai-codex-responses", id } as Model<"openai-codex-responses">;
		const settings = loadModelSettings(model, cwd);
		assert.equal(settings.imageGenerationImplementation, undefined);
	}));
}
