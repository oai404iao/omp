import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	modelCatalogDiagnostics,
	modelsPath,
	resolveModelProfile,
} from "../src/model-catalog/catalog.js";
import { loadModelSettings } from "../src/model-catalog/runtime.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";

function withAgentDir<T>(fn: (agentDir: string) => T): T {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const agentDir = mkdtempSync(join(tmpdir(), "pi-codex-model-catalog-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		return fn(agentDir);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	}
}

function writeModels(agentDir: string, value: unknown): void {
	const path = join(agentDir, "extensions", "pi-codex-minimal-tools", "models.json");
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}

test("bundled profiles expose independent Standard and Lite Codex capabilities", () => withAgentDir(() => {
	const standard = resolveModelProfile(
		{ provider: "openai", id: "gpt-5.5" },
		{ settings: DEFAULT_SETTINGS },
	);
	assert.ok(standard);
	assert.deepEqual(standard.sources, ["bundled"]);
	assert.equal(standard.effective.responses.mode, "standard");
	assert.equal(standard.effective.responses.transport, "auto");
	assert.equal(standard.effective.tools.applyPatch, "custom");
	assert.deepEqual(standard.effective.tools.webSearch, {
		implementation: "hosted",
		contentTypes: ["text", "image"],
	});
	assert.equal(standard.effective.tools.imageGeneration, "standalone");
	assert.equal(standard.effective.compaction, "responses");
	assert.equal(standard.effective.fast && standard.effective.fast.serviceTier, "priority");

	const lite = resolveModelProfile(
		{ provider: "openai-codex", id: "gpt-5.6-sol" },
		{ settings: DEFAULT_SETTINGS },
	);
	assert.ok(lite);
	assert.equal(lite.effective.responses.endpoint, "codex");
	assert.equal(lite.effective.responses.mode, "lite");
	assert.equal(lite.effective.responses.systemPromptPlacement, "developer");
	assert.equal(lite.effective.tools.parallelCalls, false);
	assert.equal(lite.effective.tools.applyPatch, "custom");
	assert.equal(lite.effective.tools.webSearch && lite.effective.tools.webSearch.implementation, "standalone");
	assert.equal(lite.effective.tools.imageGeneration, "standalone");
	assert.equal(lite.effective.compaction, "responses");
}));

test("user entries deep-override bundled profiles by exact provider/model id", () => withAgentDir((agentDir) => {
	writeModels(agentDir, {
		version: 1,
		models: [{
			id: "openai/gpt-5.5",
			responses: {
				transport: "sse",
				websocketPrewarm: false,
			},
			tools: {
				webSearch: false,
			},
			fast: false,
		}],
	});

	const profile = resolveModelProfile(
		{ provider: "openai", id: "gpt-5.5" },
		{ settings: DEFAULT_SETTINGS },
	);
	assert.ok(profile);
	assert.deepEqual(profile.sources, ["bundled", "user"]);
	assert.equal(profile.effective.responses.mode, "standard");
	assert.equal(profile.effective.responses.transport, "sse");
	assert.equal(profile.effective.responses.websocketPrewarm, false);
	assert.equal(profile.effective.tools.applyPatch, "custom");
	assert.equal(profile.effective.tools.webSearch, false);
	assert.equal(profile.effective.fast, false);
}));

test("users can add an exact custom model profile with extends", () => withAgentDir((agentDir) => {
	writeModels(agentDir, {
		version: 1,
		models: [{
			id: "my-provider/my-codex-model",
			extends: "openai/gpt-5.5",
			responses: {
				endpoint: "openai",
				transport: "websocket-cached",
			},
			tools: {
				imageGeneration: false,
			},
		}],
	});

	const settings = loadModelSettings(
		{ provider: "my-provider", id: "my-codex-model", api: "openai-responses" },
		undefined,
		DEFAULT_SETTINGS,
	);
	assert.equal(settings.modelProfile?.sources.join("+"), "user");
	assert.equal(settings.openaiTransport, "websocket-cached");
	assert.equal(settings.requestProfile.patchTransport, "custom");
	assert.equal(settings.webSearchImplementation, "hosted");
	assert.equal(settings.imageGenerationImplementation, undefined);
	assert.equal(settings.apiKeyMode, true);
	assert.equal(settings.modelProfile?.effective.responses.providerShim, true);
}));

test("provider-shim features require an OpenAI Responses API binding", () => withAgentDir((agentDir) => {
	writeModels(agentDir, {
		version: 1,
		models: [{
			id: "custom/wrong-api",
			extends: "openai/gpt-5.5",
		}],
	});
	const settings = loadModelSettings(
		{ provider: "custom", id: "wrong-api", api: "openai-completions" },
		undefined,
		DEFAULT_SETTINGS,
	);
	assert.equal(settings.providerShimActive, false);
	assert.equal(settings.webSearchImplementation, undefined);
	assert.equal(settings.imageGenerationImplementation, "standalone");
	assert.equal(settings.compactionMode, "pi");
	assert.equal(settings.fastServiceTier, undefined);
}));

test("global package disable keeps the model profile visible but disables derived behavior", () => withAgentDir(() => {
	const settings = loadModelSettings(
		{ provider: "openai", id: "gpt-5.5", api: "openai-responses" },
		undefined,
		{ ...DEFAULT_SETTINGS, enabled: false },
	);
	assert.ok(settings.modelProfile);
	assert.equal(settings.providerShimActive, false);
	assert.equal(settings.webSearchImplementation, undefined);
	assert.equal(settings.imageGenerationImplementation, undefined);
	assert.equal(settings.compactionMode, "pi");
	assert.equal(settings.applyPatchEnabled, false);
	assert.equal(settings.fastServiceTier, undefined);
}));

test("profiles without the provider shim retain standalone and function tools but disable wire-only features", () => withAgentDir((agentDir) => {
	writeModels(agentDir, {
		version: 1,
		models: [{
			id: "custom/no-shim",
			extends: "openai/gpt-5.5",
			responses: { providerShim: false },
			tools: {
				applyPatch: "function",
				webSearch: {
					implementation: "standalone",
					contentTypes: ["text"],
				},
				imageGeneration: "standalone",
			},
		}],
	});
	const profile = resolveModelProfile(
		{ provider: "custom", id: "no-shim", api: "openai-completions" },
		{ settings: DEFAULT_SETTINGS },
	);
	assert.ok(profile);
	assert.equal(profile.effective.responses.providerShim, false);
	assert.equal(profile.effective.tools.applyPatch, "function");
	assert.deepEqual(profile.effective.tools.webSearch, {
		implementation: "standalone",
		contentTypes: ["text"],
	});
	assert.equal(profile.effective.tools.imageGeneration, "standalone");
	assert.equal(profile.effective.compaction, "pi");
	assert.equal(profile.effective.fast, false);
	assert.ok(profile.diagnostics.some((line) => line.includes("native compaction requires responses.providerShim")));
	assert.ok(profile.diagnostics.some((line) => line.includes("Fast service tiers require responses.providerShim")));
}));

test("Lite normalization rejects hosted tools but preserves remote compaction", () => withAgentDir((agentDir) => {
	writeModels(agentDir, {
		version: 1,
		models: [{
			id: "custom/lite",
			extends: "openai/gpt-5.5",
			responses: { mode: "lite" },
			tools: {
				parallelCalls: true,
				webSearch: { implementation: "hosted" },
				imageGeneration: "hosted",
			},
			compaction: "responses",
		}],
	});
	const profile = resolveModelProfile(
		{ provider: "custom", id: "lite" },
		{ settings: DEFAULT_SETTINGS },
	);
	assert.ok(profile);
	assert.equal(profile.effective.responses.systemPromptPlacement, "developer");
	assert.equal(profile.effective.tools.parallelCalls, false);
	assert.equal(profile.effective.tools.webSearch, false);
	assert.equal(profile.effective.tools.imageGeneration, false);
	assert.equal(profile.effective.compaction, "responses");
	assert.ok(profile.diagnostics.some((line) => line.includes("Responses Lite cannot use hosted web search")));
}));

test("invalid versions, missing parents, and cycles are diagnosed without enabling models", () => withAgentDir((agentDir) => {
	writeModels(agentDir, {
		version: 1,
		models: [
			{ id: "custom/missing", extends: "custom/nope" },
			{ id: "custom/a", extends: "custom/b" },
			{ id: "custom/b", extends: "custom/a" },
		],
	});
	assert.equal(resolveModelProfile({ provider: "custom", id: "missing" }, { settings: DEFAULT_SETTINGS }), undefined);
	assert.equal(resolveModelProfile({ provider: "custom", id: "a" }, { settings: DEFAULT_SETTINGS }), undefined);
	const diagnostics = modelCatalogDiagnostics();
	assert.ok(diagnostics.some((line) => line.includes("extends missing or invalid profile")));
	assert.ok(diagnostics.some((line) => line.includes("cyclic extends")));

	writeModels(agentDir, { version: 2, models: [{ id: "custom/version-two" }] });
	assert.equal(resolveModelProfile({ provider: "custom", id: "version-two" }, { settings: DEFAULT_SETTINGS }), undefined);
	assert.ok(modelCatalogDiagnostics().some((line) => line.includes("version must be 1")));
}));

test("modelsPath points to the extension models.json", () => withAgentDir((agentDir) => {
	assert.equal(
		modelsPath(),
		join(agentDir, "extensions", "pi-codex-minimal-tools", "models.json"),
	);
}));

test("profile hashes change when effective request behavior changes", () => withAgentDir((agentDir) => {
	const before = resolveModelProfile(
		{ provider: "openai", id: "gpt-5.5" },
		{ settings: DEFAULT_SETTINGS },
	);
	assert.ok(before);
	writeModels(agentDir, {
		version: 1,
		models: [{
			id: "openai/gpt-5.5",
			responses: { transport: "sse" },
		}],
	});
	const after = resolveModelProfile(
		{ provider: "openai", id: "gpt-5.5" },
		{ settings: DEFAULT_SETTINGS },
	);
	assert.ok(after);
	assert.notEqual(after.profileHash, before.profileHash);
}));
