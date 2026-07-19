import assert from "node:assert/strict";
import test from "node:test";
import { computeNextActiveTools, computeToolCapabilities, isGpt5SeriesModel, isOpenAiGpt5Model } from "../src/capabilities.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";

const codex55 = { provider: "openai-codex", id: "gpt-5.5", input: ["text", "image"] };
const textOnlyCodex = { provider: "openai-codex", id: "text-only-codex", input: ["text"] };
const openai = { provider: "openai", id: "gpt-5.5", input: ["text", "image"] };

test("capability gating follows provider and image support", () => {
	const withViewImage = { ...DEFAULT_SETTINGS, viewImage: true };

	const codex = computeToolCapabilities(codex55, withViewImage);
	assert.equal(codex.image_generation.enabled, true);
	assert.equal(codex.view_image.enabled, true);
	assert.equal(codex.apply_patch.enabled, false);
	assert.equal(codex.web_search.enabled, false);

	const textOnlyCodexCaps = computeToolCapabilities(textOnlyCodex, withViewImage);
	assert.equal(textOnlyCodexCaps.image_generation.enabled, false);
	assert.equal(textOnlyCodexCaps.view_image.enabled, false);
	assert.equal(textOnlyCodexCaps.apply_patch.enabled, false);

	const openaiCaps = computeToolCapabilities(openai, withViewImage);
	assert.equal(openaiCaps.image_generation.enabled, true);
	assert.equal(openaiCaps.view_image.enabled, true);
	assert.equal(openaiCaps.apply_patch.enabled, true);
	assert.equal(openaiCaps.web_search.enabled, false);

	const nonOpenAiVision = computeToolCapabilities({ provider: "claude-bridge", id: "claude-opus-4-7", input: ["text", "image"] }, withViewImage);
	assert.equal(nonOpenAiVision.image_generation.enabled, false);
	assert.equal(nonOpenAiVision.view_image.enabled, false);
	assert.equal(nonOpenAiVision.apply_patch.enabled, false);

	const defaults = computeToolCapabilities(codex55, DEFAULT_SETTINGS);
	assert.equal(defaults.view_image.enabled, false, "view_image is gated off by default");
	assert.equal(defaults.web_search.enabled, false, "web_search is gated off by default");
});

test("apply_patch is limited to GPT-5-series models on the openai provider", () => {
	assert.equal(computeToolCapabilities({ provider: "openai", id: "gpt-5", input: ["text"] }, DEFAULT_SETTINGS).apply_patch.enabled, true);
	assert.equal(computeToolCapabilities({ provider: "openai", id: "gpt-5.5", input: ["text"] }, DEFAULT_SETTINGS).apply_patch.enabled, true);
	assert.equal(computeToolCapabilities({ provider: "openai", id: "gpt-4.1", input: ["text"] }, DEFAULT_SETTINGS).apply_patch.enabled, false);
	assert.equal(computeToolCapabilities({ provider: "openai-codex", id: "gpt-5.5", input: ["text"] }, DEFAULT_SETTINGS).apply_patch.enabled, false);
	assert.equal(computeToolCapabilities({ provider: "openrouter", id: "gpt-5.5", input: ["text"] }, DEFAULT_SETTINGS).apply_patch.enabled, false);
	assert.equal(computeToolCapabilities({ provider: "openai", id: "gpt-5.5", input: ["text"] }, { ...DEFAULT_SETTINGS, applyPatchEnabled: false }).apply_patch.enabled, false);
	assert.equal(isOpenAiGpt5Model({ provider: "OpenAI", id: "gpt-5-mini" }), true);
	assert.equal(isOpenAiGpt5Model({ provider: "openai-codex", id: "gpt-5-mini" }), false);
});

test("web_search is GPT-5 openai/openai-codex only and off by default", () => {
	const enabledSettings = { ...DEFAULT_SETTINGS, webSearchEnabled: true };
	assert.equal(computeToolCapabilities({ provider: "openai-codex", id: "gpt-5", input: ["text"] }, enabledSettings).web_search.enabled, true);
	assert.equal(computeToolCapabilities({ provider: "openai-codex", id: "gpt-5.5", input: ["text"] }, enabledSettings).web_search.enabled, true);
	assert.equal(computeToolCapabilities({ provider: "openai-codex", id: "gpt-5-mini", input: ["text"] }, enabledSettings).web_search.enabled, true);
	assert.equal(computeToolCapabilities({ provider: "openai", id: "gpt-5", input: ["text"] }, enabledSettings).web_search.enabled, true);
	assert.equal(computeToolCapabilities({ provider: "openai-codex", id: "gpt-4.1", input: ["text"] }, enabledSettings).web_search.enabled, false);
	assert.equal(computeToolCapabilities({ provider: "openai-codex", id: "o4-mini", input: ["text"] }, enabledSettings).web_search.enabled, false);
	assert.equal(computeToolCapabilities({ provider: "openai-codex", id: "gpt-50", input: ["text"] }, enabledSettings).web_search.enabled, false);
	assert.equal(computeToolCapabilities({ provider: "openai-codex", id: "gpt-5", input: ["text"] }, { ...enabledSettings, nativeProviderTools: false }).web_search.enabled, false);
	assert.equal(isGpt5SeriesModel({ id: "gpt-5" }), true);
	assert.equal(isGpt5SeriesModel({ id: "gpt-50" }), false);
});

test("active tool sync preserves native tools and only manages package tools", () => {
	const current = ["read", "grep", "find", "ls", "bash", "edit", "write", "old_custom"];
	const next = computeNextActiveTools(current, codex55, { ...DEFAULT_SETTINGS, viewImage: true });
	for (const nativeTool of ["read", "grep", "find", "ls", "bash", "edit", "write"]) assert.ok(next.activeTools.includes(nativeTool));
	assert.ok(next.activeTools.includes("old_custom"));
	assert.ok(next.activeTools.includes("image_generation"));
	assert.ok(next.activeTools.includes("view_image"));
	assert.equal(next.activeTools.includes("apply_patch"), false);
});

test("unsupported package tools are removed without touching native tools", () => {
	const current = ["read", "edit", "write", "image_generation", "view_image", "apply_patch", "web_search"];
	const next = computeNextActiveTools(current, { provider: "anthropic", id: "claude", input: ["text"] }, { ...DEFAULT_SETTINGS, viewImage: true, webSearchEnabled: true });
	assert.deepEqual(next.activeTools, ["read", "edit", "write"]);
	assert.deepEqual(next.removed.sort(), ["apply_patch", "image_generation", "view_image", "web_search"].sort());
});

test("active tool sync auto-adds web_search only when desired", () => {
	const next = computeNextActiveTools(["read"], { provider: "openai-codex", id: "gpt-5", input: ["text"] }, { ...DEFAULT_SETTINGS, webSearchEnabled: true });
	assert.ok(next.activeTools.includes("web_search"));
	assert.ok(next.added.includes("web_search"));
	const openaiNext = computeNextActiveTools(["read"], { provider: "openai", id: "gpt-5", input: ["text"] }, { ...DEFAULT_SETTINGS, webSearchEnabled: true });
	assert.ok(openaiNext.activeTools.includes("web_search"));

	const defaultSettings = computeNextActiveTools(["read"], { provider: "openai-codex", id: "gpt-5", input: ["text"] }, DEFAULT_SETTINGS);
	assert.equal(defaultSettings.activeTools.includes("web_search"), false);
});

test("apply_patch automatically replaces native mutation tools on supported models", () => {
	const current = ["read", "edit", "write"];
	const next = computeNextActiveTools(current, { provider: "openai", id: "gpt-5.5", input: ["text"] }, DEFAULT_SETTINGS);
	assert.deepEqual(next.activeTools, ["read", "apply_patch"]);
	assert.deepEqual(next.added, ["apply_patch"]);
	assert.deepEqual(next.removed.sort(), ["edit", "write"].sort());
});

test("Responses Lite disables hosted tools without disabling supported apply_patch", () => {
	const capabilities = computeToolCapabilities(codex55, {
		...DEFAULT_SETTINGS,
		webSearchEnabled: true,
		requestProfile: { responsesMode: "lite", supportsHostedTools: true },
	});
	assert.equal(capabilities.image_generation.enabled, false);
	assert.equal(capabilities.web_search.enabled, false);
	assert.equal(capabilities.apply_patch.enabled, false);

	const openAiCapabilities = computeToolCapabilities(openai, {
		...DEFAULT_SETTINGS,
		webSearchEnabled: true,
		requestProfile: { responsesMode: "lite", supportsHostedTools: true },
	});
	assert.equal(openAiCapabilities.apply_patch.enabled, true);
});
