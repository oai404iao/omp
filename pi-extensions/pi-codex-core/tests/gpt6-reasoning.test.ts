import assert from "node:assert/strict";
import test from "node:test";
import { type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveCodexRequestProfile } from "@oai404iao/pi-codex-runtime/internal/codex-request-profile";
import { buildRequestBody } from "../src/providers/openai-codex/request-body.js";
import { startupPrewarmSnapshot } from "../src/extension/prewarm-snapshot.js";
import { thinkingLevelFromUnknown } from "../src/providers/openai-codex/reasoning.js";
import { withCodexSettings } from "../../../tests/codex/support/provider-lifecycle-test-support.js";

const levels: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

for (const provider of ["openai", "openai-codex"] as const) {
	for (const id of ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"]) {
		for (const responsesMode of ["standard", "lite"] as const) {
			test(`${provider}/${id} ${responsesMode}: every Pi level respects descriptor support`, () =>
				withCodexSettings({}, async () => {
					const model = getBuiltinModels(provider).find(model => model.id === id);
					assert(model);
					const expected = [
						id === "gpt-6-astra" || id === "gpt-6.1-sol" ? "low" : "none",
						"low", "low", "medium", "high", "xhigh", "max",
					];
					for (const [index, reasoning] of levels.entries()) {
						const body: ReturnType<typeof buildRequestBody> = buildRequestBody(model, { messages: [] },
							resolveCodexRequestProfile({ responsesMode }), { reasoning });
						assert.equal(body.reasoning?.effort, expected[index], reasoning);
						assert.equal(body.reasoning?.context, responsesMode === "lite" ? "all_turns" : undefined);
					}
				}));
		}
	}
}

for (const responsesMode of ["standard", "lite"] as const) {
	test(`${responsesMode}: explicit provider-native mapping is honored, not inferred from GPT-6 names`, () =>
		withCodexSettings({}, async () => {
			const original = getBuiltinModels("openai").find(model => model.id === "gpt-6-astra")!;
			const model = { ...original, thinkingLevelMap: { ...original.thinkingLevelMap, max: "mapped-max" } };
			const profile = resolveCodexRequestProfile({ responsesMode });
			assert.equal(buildRequestBody(model, { messages: [] }, profile, { reasoning: "max" }).reasoning?.effort, "mapped-max");
			assert.equal(buildRequestBody(original, { messages: [] }, profile, { reasoning: "max" }).reasoning?.effort, "max");
			assert.equal(buildRequestBody(model, { messages: [] }, profile, { reasoning: "xhigh" }).reasoning?.effort, "xhigh");
		}));

	test(`${responsesMode}: existing non-GPT-6 descriptors retain their clamping and Off semantics`, () =>
		withCodexSettings({}, async () => {
			const profile = resolveCodexRequestProfile({ responsesMode });
			const model = getBuiltinModels("openai-codex").find(model => model.id === "gpt-5.6-sol")!;
			assert(model);
			for (const [reasoning, expected] of [["off", undefined], ["minimal", "low"], ["low", "low"],
				["medium", "medium"], ["high", "high"], ["xhigh", "xhigh"], ["max", "max"]] as const) {
				assert.equal(buildRequestBody(model, { messages: [] }, profile, { reasoning }).reasoning?.effort, expected, reasoning);
			}
			assert.equal(buildRequestBody({ ...model, reasoning: false }, { messages: [] }, profile,
				{ reasoning: "max" }).reasoning?.effort, undefined);
		}));
}

test("startup prewarm preserves all Pi selections including Off and rejects non-Pi values", () => {
	for (const level of levels) {
		assert.equal(thinkingLevelFromUnknown(level), level);
		assert.equal(startupPrewarmSnapshot({ getThinkingLevel: () => level } as ExtensionAPI, {}).reasoning, level);
		assert.equal(startupPrewarmSnapshot({ getThinkingLevel: () => "medium" } as ExtensionAPI,
			{ thinkingLevel: level }).reasoning, level);
	}
	for (const value of ["ultra", "", null, undefined, {}, 1]) assert.equal(thinkingLevelFromUnknown(value), undefined);
});
