import assert from "node:assert/strict";
import test from "node:test";
import {
	OPENAI_CODEX_ASTRA_MODEL,
	appendAstraModel,
	createSupplementalOpenAICodexProvider,
} from "../src/providers/openai-codex/model-catalog.js";

test("Astra supplemental metadata matches the Codex subscription route", () => {
	assert.equal(OPENAI_CODEX_ASTRA_MODEL.provider, "openai-codex");
	assert.equal(OPENAI_CODEX_ASTRA_MODEL.api, "openai-codex-responses");
	assert.deepEqual(OPENAI_CODEX_ASTRA_MODEL.input, ["text", "image"]);
	assert.equal(OPENAI_CODEX_ASTRA_MODEL.contextWindow, 272_000);
	assert.equal(OPENAI_CODEX_ASTRA_MODEL.maxTokens, 128_000);
	assert.equal(OPENAI_CODEX_ASTRA_MODEL.compat.supportsAdditionalTools, true);
	assert.equal(OPENAI_CODEX_ASTRA_MODEL.compat.supportsOpenAIGrammarTools, true);
});

test("Astra supplementation preserves provider identity, auth, streams, and existing models", () => {
	const models = [
		{ id: "gpt-existing", provider: "openai-codex" },
		{ id: "user-model", provider: "openai-codex" },
	] as any[];
	const auth = { oauth: {} };
	const stream = () => ({});
	const originalSimple = () => ({ original: true });
	const replacementSimple = () => ({ replacement: true });
	const provider = {
		id: "openai-codex",
		name: "OpenAI Codex",
		baseUrl: "https://chatgpt.com/backend-api",
		auth,
		getModels: () => models,
		stream,
		streamSimple: originalSimple,
	} as any;
	const supplemented = createSupplementalOpenAICodexProvider(
		replacementSimple as any,
		[provider],
	);
	assert.ok(supplemented);
	assert.equal(supplemented.auth, auth);
	assert.equal(supplemented.stream, stream);
	assert.equal(supplemented.streamSimple, replacementSimple);
	assert.deepEqual(
		supplemented.getModels().map(model => model.id),
		["gpt-existing", "user-model", "gpt-6-astra"],
	);
	const current = supplemented.getModels();
	assert.equal(appendAstraModel(current), current);
	assert.equal(
		createSupplementalOpenAICodexProvider(replacementSimple as any, [supplemented]),
		undefined,
	);
});
