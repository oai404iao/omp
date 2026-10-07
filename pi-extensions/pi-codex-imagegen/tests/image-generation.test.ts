import assert from "node:assert/strict";
import test from "node:test";
import { createImageGenerationToolDefinition, standaloneImageGeneration } from "@oai404iao/pi-codex-imagegen/internal/tools/image-generation";
import * as generation from "@oai404iao/pi-codex-imagegen/internal/tools/image-generation";
import * as background from "@oai404iao/pi-codex-imagegen/internal/background-image-generation";
import { DEFAULT_SETTINGS } from "@oai404iao/pi-codex-runtime/internal/settings";
import { loadModelSettings } from "@oai404iao/pi-codex-runtime/internal/model-catalog/runtime";
import { withCodexSettings } from "../../../tests/codex/support/provider-lifecycle-test-support.js";

const model = { provider: "openai", api: "openai-responses", id: "gpt-5.6-sol", baseUrl: "https://fixture.invalid" } as any;

test("hosted and direct image execution exports are removed", () => {
	assert.equal("directImageGeneration" in generation, false);
	assert.equal("buildBackgroundImageRequest" in background, false);
});

test("global image gate blocks standalone before authentication", () => withCodexSettings({ imageGeneration: false }, async cwd => {
	let authRequested = false;
	await assert.rejects(standaloneImageGeneration({ prompt: "fixture" }, {
		cwd, model, modelRegistry: { async getApiKeyAndHeaders() { authRequested = true; throw new Error("unexpected"); } },
	}, loadModelSettings(model, cwd)), /global setting or current model profile/);
	assert.equal(authRequested, false);
}));

test("image execution does not borrow an environment key after Pi auth fails", () => withCodexSettings({}, async cwd => {
	const previousKey = process.env.OPENAI_API_KEY;
	process.env.OPENAI_API_KEY = "must-not-use";
	try {
		for (const throws of [false, true]) {
			await assert.rejects(standaloneImageGeneration({ prompt: "test" }, {
				cwd, model, modelRegistry: { async getApiKeyAndHeaders() {
					if (throws) throw new Error("fixture auth failure");
					return { ok: false, error: "fixture auth failure" };
				} },
			}, loadModelSettings(model, cwd)), /fixture auth failure/);
		}
	} finally {
		if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = previousKey;
	}
}));

test("per-model image gate blocks manual execution before auth", () => withCodexSettings({}, async cwd => {
	let authRequested = false;
	const tool = createImageGenerationToolDefinition({ loadSettings: () => ({ ...DEFAULT_SETTINGS }) });
	await assert.rejects(tool.execute("disabled", { prompt: "test" }, undefined, undefined, {
		cwd, model: { ...model, id: "o4-mini" },
		modelRegistry: { async getApiKeyAndHeaders() { authRequested = true; return { ok: true, apiKey: "unused" }; } },
	}), /global setting or current model profile/);
	assert.equal(authRequested, false);
}));
