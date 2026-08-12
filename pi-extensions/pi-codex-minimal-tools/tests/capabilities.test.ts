import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { computeNextActiveTools, computeToolCapabilities } from "../src/capabilities.js";
import { loadModelSettings } from "../src/model-catalog/runtime.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";

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
	assert.equal(codex.view_image.enabled, false);
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

test("Responses Lite profiles keep standalone tools and custom apply_patch", () => withAgentDir(() => {
	const model = { provider: "openai", id: "gpt-5.6-sol", input: ["text", "image"] };
	const capabilities = computeToolCapabilities(model, DEFAULT_SETTINGS);
	const settings = loadModelSettings(model, undefined, DEFAULT_SETTINGS);

	assert.equal(settings.requestProfile.responsesMode, "lite");
	assert.equal(settings.requestProfile.patchTransport, "custom");
	assert.equal(settings.requestProfile.supportsHostedTools, false);
	assert.equal(settings.requestProfile.supportsParallelTools, false);
	assert.equal(settings.webSearchImplementation, "standalone");
	assert.equal(settings.imageGenerationImplementation, "standalone");
	assert.equal(capabilities.apply_patch.enabled, true);
	assert.equal(capabilities.web_search.enabled, true);
	assert.equal(capabilities.image_generation.enabled, true);
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

test("active tool sync follows the model profile and preserves unrelated tools", () => withAgentDir(() => {
	const current = ["read", "bash", "edit", "write", "old_custom"];
	const next = computeNextActiveTools(
		current,
		{ provider: "openai", id: "gpt-5.5", input: ["text"] },
		DEFAULT_SETTINGS,
	);
	assert.deepEqual(next.activeTools, ["read", "bash", "old_custom", "apply_patch", "web_search"]);
	assert.deepEqual(next.added, ["apply_patch", "web_search"]);
	assert.deepEqual(next.removed.sort(), ["edit", "write"].sort());
}));

test("unsupported models remove only package tools", () => withAgentDir(() => {
	const current = ["read", "edit", "write", "image_generation", "view_image", "apply_patch", "web_search"];
	const next = computeNextActiveTools(
		current,
		{ provider: "anthropic", id: "claude", input: ["text"] },
		DEFAULT_SETTINGS,
	);
	assert.deepEqual(next.activeTools, ["read", "edit", "write"]);
	assert.deepEqual(next.removed.sort(), ["apply_patch", "image_generation", "view_image", "web_search"].sort());
}));
