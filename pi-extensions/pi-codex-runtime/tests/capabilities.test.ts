import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { computeToolCapabilities } from "@oai404iao/pi-codex-runtime/internal/capabilities";
import { loadModelSettings } from "@oai404iao/pi-codex-runtime/internal/model-catalog/runtime";
import { DEFAULT_SETTINGS } from "@oai404iao/pi-codex-runtime/internal/settings";

function withAgentDir<T>(fn: () => T): T {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const agentDir = mkdtempSync(join(tmpdir(), "pi-codex-capabilities-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		return fn();
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	}
}

const codex55 = { provider: "openai-codex", id: "gpt-5.5", input: ["text", "image"] };
const openai55 = { provider: "openai", id: "gpt-5.5", input: ["text", "image"] };

test("tool capabilities come from the exact model profile and input modalities", () => withAgentDir(() => {
	const codex = computeToolCapabilities(codex55, DEFAULT_SETTINGS);
	assert.equal(codex.image_generation.enabled, true);
	assert.deepEqual(Object.keys(codex), ["image_generation", "apply_patch", "web_search"]);
	assert.equal(codex.apply_patch.enabled, true);
	assert.equal(codex.web_search.enabled, true);

	const textOnly = computeToolCapabilities(
		{ ...codex55, input: ["text"] },
		DEFAULT_SETTINGS,
	);
	assert.equal(textOnly.image_generation.enabled, false);
	assert.equal(textOnly.apply_patch.enabled, true);
	assert.equal(textOnly.web_search.enabled, true);

	const gpt41 = computeToolCapabilities(
		{ provider: "openai", id: "gpt-4.1", input: ["text", "image"] },
		DEFAULT_SETTINGS,
	);
	assert.equal(gpt41.image_generation.enabled, true);
	assert.equal(gpt41.apply_patch.enabled, false);
	assert.equal(gpt41.web_search.enabled, false);

	const unknown = computeToolCapabilities(
		{ provider: "openrouter", id: "gpt-5.5", input: ["text", "image"] },
		DEFAULT_SETTINGS,
	);
	assert.ok(Object.values(unknown).every((capability) => !capability.enabled));
}));

test("all global tool-gate combinations preserve protocol and unrelated capabilities", () => withAgentDir(() => {
	const model = { provider: "openai", id: "gpt-5.6-sol", api: "openai-responses", input: ["text", "image"] };
	for (const applyPatch of [false, true]) {
		for (const webSearch of [false, true]) {
			for (const imageGeneration of [false, true]) {
				const base = { ...DEFAULT_SETTINGS, applyPatch, webSearch, imageGeneration };
				const capabilities = computeToolCapabilities(model, base);
				assert.equal(capabilities.apply_patch.enabled, applyPatch);
				assert.equal(capabilities.web_search.enabled, webSearch);
				assert.equal(capabilities.image_generation.enabled, imageGeneration);
				const resolved = loadModelSettings(model, undefined, base);
				assert.deepEqual(resolved.modelProfile?.sources, ["bundled"]);
				assert.equal(resolved.requestProfile.responsesMode, "lite");
				assert.equal(resolved.openaiTransport, "auto");
				assert.equal(resolved.compactionMode, "responses");
				assert.equal(resolved.applyPatchEnabled, applyPatch);
				assert.equal(resolved.webSearchEnabled, webSearch);
				assert.equal(resolved.imageGeneration, imageGeneration);
			}
		}
	}
}));

test("endpoint tool denial is reflected in capability projection without disabling local patch", () => withAgentDir(() => {
	const model = { ...openai55, api: "openai-responses", baseUrl: "https://fixture.invalid/v1" };
	const capabilities = computeToolCapabilities(model, { ...DEFAULT_SETTINGS, endpoint_config: [
		{ provider: model.provider, baseUrl: model.baseUrl, webSearch: [], imageGeneration: [] },
	] });
	assert.equal(capabilities.apply_patch.enabled, true);
	assert.equal(capabilities.web_search.enabled, false);
	assert.equal(capabilities.image_generation.enabled, false);
}));

test("legacy model settings remain a one-version compatibility override", () => withAgentDir(() => {
	const disabledPatch = computeToolCapabilities(openai55, {
		...DEFAULT_SETTINGS,
		applyPatchEnabled: false,
	});
	assert.equal(disabledPatch.apply_patch.enabled, false);
	assert.equal(disabledPatch.web_search.enabled, false);

	const oldCodexDefaults = computeToolCapabilities(codex55, {
		...DEFAULT_SETTINGS,
		webSearchEnabled: true,
	});
	assert.equal(oldCodexDefaults.apply_patch.enabled, false);
	assert.equal(oldCodexDefaults.web_search.enabled, false);
}));

test("additionalModelIds remains compatible for exact custom model ids", () => withAgentDir(() => {
	const settings = {
		...DEFAULT_SETTINGS,
		webSearchEnabled: true,
		additionalModelIds: [
			"openai/deepseek-v4-flash",
			"custom/deepseek-v4-flash",
		],
	};
	const openAiCustom = computeToolCapabilities(
		{ provider: "openai", id: "deepseek-v4-flash", input: ["text"] },
		settings,
	);
	assert.equal(openAiCustom.apply_patch.enabled, true);
	assert.equal(openAiCustom.web_search.enabled, true);

	const customProvider = computeToolCapabilities(
		{ provider: "custom", id: "deepseek-v4-flash", input: ["text"] },
		settings,
	);
	assert.equal(customProvider.apply_patch.enabled, true);
	assert.equal(customProvider.web_search.enabled, false);

	const unlisted = computeToolCapabilities(
		{ provider: "openai", id: "deepseek-v4", input: ["text"] },
		settings,
	);
	assert.ok(Object.values(unlisted).every((capability) => !capability.enabled));
}));
