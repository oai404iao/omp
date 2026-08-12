import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import codexMinimalTools from "../src/index.js";
import { hasConfiguredModelsLoaded } from "../src/activation.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";

function fakePi() {
	const handlers: Record<string, Function[]> = {};
	const tools: any[] = [];
	const providers: Array<{ name: string; value: any }> = [];
	let activeTools = ["read", "bash"];
	return {
		activeTools,
		handlers,
		providers,
		tools,
		registerCommand() {},
		registerProvider(name: string, value: any) { providers.push({ name, value }); },
		registerMessageRenderer() {},
		registerTool(tool: any) { tools.push(tool); },
		on(event: string, handler: Function) { (handlers[event] ??= []).push(handler); },
		getActiveTools() { return activeTools; },
		setActiveTools(next: string[]) { activeTools = next; this.activeTools = next; },
	};
}

async function emit(pi: ReturnType<typeof fakePi>, event: string, ctx: any, eventPayload: Record<string, unknown> = {}): Promise<void> {
	for (const handler of pi.handlers[event] ?? []) await handler(eventPayload, ctx);
}

function writeConfig(agentDir: string, config: Record<string, unknown>): void {
	const configDir = join(agentDir, "extensions", "pi-codex-minimal-tools");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(configDir, "config.json"), JSON.stringify(config));
}

function writeModels(agentDir: string, models: unknown[]): void {
	const configDir = join(agentDir, "extensions", "pi-codex-minimal-tools");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(configDir, "models.json"), JSON.stringify({ version: 1, models }));
}

async function withAgentDir(fn: (agentDir: string) => Promise<void>): Promise<void> {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const agentDir = mkdtempSync(join(tmpdir(), "pi-codex-minimal-tools-activation-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		await fn(agentDir);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	}
}

test("hasConfiguredModelsLoaded detects exact catalog profiles", () => {
	assert.equal(hasConfiguredModelsLoaded({
		model: { provider: "anthropic", id: "claude" },
		modelRegistry: { getAll: () => [] },
	}, DEFAULT_SETTINGS), false);
	assert.equal(hasConfiguredModelsLoaded({
		model: { provider: "openai-codex", id: "gpt-5.5" },
		modelRegistry: { getAll: () => [] },
	}, DEFAULT_SETTINGS), true);
	assert.equal(hasConfiguredModelsLoaded({
		modelRegistry: { getAll: () => [{ provider: "openai", id: "gpt-5.6-sol" }] },
	}, DEFAULT_SETTINGS), true);
	assert.equal(hasConfiguredModelsLoaded({
		modelRegistry: {
			find: (provider: string, id: string) =>
				provider === "openai" && id === "gpt-5.2" ? { provider, id } : undefined,
		},
	}, DEFAULT_SETTINGS), true);
});

test("extension does not register tools until a configured model is loaded", async () => withAgentDir(async () => {
	const pi = fakePi();
	codexMinimalTools(pi as any);
	assert.equal(pi.tools.length, 0);

	await emit(pi, "session_start", {
		cwd: process.cwd(),
		model: { provider: "anthropic", id: "claude", input: ["text"] },
		modelRegistry: { getAll: () => [{ provider: "anthropic", id: "claude" }] },
	});
	assert.equal(pi.tools.length, 0);
	assert.deepEqual(pi.activeTools, ["read", "bash"]);

	await emit(pi, "model_select", {
		cwd: process.cwd(),
		model: { provider: "openai-codex", id: "gpt-5.5", input: ["text", "image"] },
		modelRegistry: { getAll: () => [{ provider: "openai-codex", id: "gpt-5.5" }] },
	});
	assert.equal(pi.tools.length, 4);
	assert.deepEqual(pi.tools.map((tool) => tool.name).sort(), ["apply_patch", "image_generation", "view_image", "web_search"].sort());
	assert.ok(pi.activeTools.includes("read"));
	assert.ok(pi.activeTools.includes("bash"));
	assert.equal(pi.activeTools.includes("apply_patch"), true);
	assert.equal(pi.activeTools.includes("web_search"), true);
	assert.equal(pi.activeTools.includes("image_generation"), true);
}));

test("provider shim remains registered when native hosted tools are disabled", async () => withAgentDir(async (agentDir) => {
	writeConfig(agentDir, { nativeProviderTools: false, requestProfile: { responsesMode: "lite" } });
	const pi = fakePi();
	codexMinimalTools(pi as any);
	assert.deepEqual(pi.providers.map((provider) => provider.name), ["openai-codex", "openai"]);
}));

test("user model profiles register a provider-preserving Responses shim", async () => withAgentDir(async (agentDir) => {
	writeModels(agentDir, [{
		id: "custom/my-codex-model",
		extends: "openai/gpt-5.5",
		responses: {
			endpoint: "openai",
			transport: "sse",
		},
	}]);
	const pi = fakePi();
	codexMinimalTools(pi as any);
	assert.equal(pi.providers.some((provider) => provider.name === "custom"), false);
	await emit(pi, "model_select", {
		cwd: process.cwd(),
		model: {
			provider: "custom",
			api: "openai-responses",
			id: "my-codex-model",
			input: ["text"],
		},
		modelRegistry: {
			getAll: () => [{
				provider: "custom",
				api: "openai-responses",
				id: "my-codex-model",
				input: ["text"],
			}],
		},
	});
	const custom = pi.providers.find((provider) => provider.name === "custom");
	assert.ok(custom);
	assert.equal(custom.value.api, "openai-responses");
	assert.equal(typeof custom.value.streamSimple, "function");
	assert.equal("baseUrl" in custom.value, false);
	assert.equal("apiKey" in custom.value, false);
	assert.equal("models" in custom.value, false);
}));

test("active non-OpenAI models remove package tools even when OpenAI models exist in registry", async () => withAgentDir(async () => {
	const pi = fakePi();
	pi.setActiveTools(["read", "view_image", "apply_patch", "image_generation", "web_search"]);
	codexMinimalTools(pi as any);

	await emit(pi, "model_select", {
		cwd: process.cwd(),
		model: { provider: "claude-bridge", id: "claude-opus-4-7", input: ["text", "image"] },
		modelRegistry: { getAll: () => [{ provider: "openai-codex", id: "gpt-5.5", input: ["text", "image"] }] },
	});

	assert.deepEqual(pi.activeTools, ["read"]);
}));

test("apply_patch follows model profiles and restores edit/write after switching away", async () => withAgentDir(async () => {
	const pi = fakePi();
	pi.setActiveTools(["read", "edit", "write"]);
	codexMinimalTools(pi as any);

	await emit(pi, "model_select", {
		cwd: process.cwd(),
		model: { provider: "openai", id: "gpt-5.5", input: ["text"] },
		modelRegistry: { getAll: () => [{ provider: "openai", id: "gpt-5.5", input: ["text"] }] },
	});
	assert.deepEqual(pi.activeTools, ["read", "apply_patch", "web_search"]);

	await emit(pi, "model_select", {
		cwd: process.cwd(),
		model: { provider: "openai", id: "gpt-4.1", input: ["text"] },
		modelRegistry: { getAll: () => [{ provider: "openai", id: "gpt-4.1", input: ["text"] }] },
	});
	assert.deepEqual(pi.activeTools, ["read", "edit", "write"]);

	await emit(pi, "model_select", {
		cwd: process.cwd(),
		model: { provider: "anthropic", id: "claude", input: ["text"] },
		modelRegistry: { getAll: () => [{ provider: "anthropic", id: "claude", input: ["text"] }] },
	});
	assert.deepEqual(pi.activeTools, ["read", "edit", "write"]);
}));

test("before_provider_request rewrites hosted web_search from the model profile", async () => withAgentDir(async () => {
	const pi = fakePi();
	codexMinimalTools(pi as any);
	const handler = pi.handlers.before_provider_request?.[0];
	assert.ok(handler);

	const payload = { tools: [{ type: "function", name: "web_search", parameters: {} }] };
	const rewritten = handler({ payload }, {
		cwd: process.cwd(),
		model: { provider: "openai-codex", id: "gpt-5.5", input: ["text"] },
		modelRegistry: { getAll: () => [] },
	});
	assert.deepEqual(rewritten.tools, [{
		type: "web_search",
		search_content_types: ["text", "image"],
	}]);

	const rewrittenOpenAi = handler({ payload }, {
		cwd: process.cwd(),
		model: { provider: "openai", id: "gpt-5.5", input: ["text"] },
		modelRegistry: { getAll: () => [] },
	});
	assert.deepEqual(rewrittenOpenAi.tools, [{
		type: "web_search",
		search_content_types: ["text", "image"],
	}]);

	const notGpt5 = handler({ payload }, {
		cwd: process.cwd(),
		model: { provider: "openai", id: "gpt-4.1", input: ["text"] },
		modelRegistry: { getAll: () => [] },
	});
	assert.equal(notGpt5, undefined);
}));

test("additionalModelIds enables apply_patch and web_search for an exact custom model id", async () => withAgentDir(async (agentDir) => {
	writeConfig(agentDir, {
		webSearchEnabled: true,
		additionalModelIds: ["openai/deepseek-v4-flash"],
	});
	const pi = fakePi();
	pi.setActiveTools(["read", "edit", "write"]);
	codexMinimalTools(pi as any);

	const ctx = {
		cwd: process.cwd(),
		model: { provider: "openai", id: "deepseek-v4-flash", input: ["text"] },
		modelRegistry: { getAll: () => [{ provider: "openai", id: "deepseek-v4-flash", input: ["text"] }] },
	};
	await emit(pi, "model_select", ctx);
	assert.deepEqual(pi.activeTools, ["read", "apply_patch", "web_search"]);

	const handler = pi.handlers.before_provider_request?.[0];
	assert.ok(handler);
	const rewritten = handler({
		payload: { tools: [{ type: "function", name: "web_search", parameters: {} }] },
	}, ctx);
	assert.deepEqual(rewritten.tools, [{
		type: "web_search",
		search_content_types: ["text"],
	}]);
}));

test("additionalModelIds can activate apply_patch for a non-OpenAI custom provider", async () => withAgentDir(async (agentDir) => {
	writeConfig(agentDir, {
		additionalModelIds: ["custom/deepseek-v4-flash"],
	});
	const pi = fakePi();
	pi.setActiveTools(["read", "edit", "write"]);
	codexMinimalTools(pi as any);

	await emit(pi, "model_select", {
		cwd: process.cwd(),
		model: { provider: "custom", id: "deepseek-v4-flash", input: ["text"] },
		modelRegistry: { getAll: () => [{ provider: "custom", id: "deepseek-v4-flash", input: ["text"] }] },
	});
	assert.deepEqual(pi.activeTools, ["read", "apply_patch"]);
}));

test("before_provider_request preserves function placeholders when hosted tools are disabled by profile", async () => withAgentDir(async (agentDir) => {
	writeConfig(agentDir, { webSearchEnabled: true, requestProfile: { supportsHostedTools: false } });
	const pi = fakePi();
	codexMinimalTools(pi as any);
	const handler = pi.handlers.before_provider_request?.[0];
	assert.ok(handler);

	const payload = { tools: [{ type: "function", name: "web_search", parameters: {} }] };
	const rewritten = handler({ payload }, {
		cwd: process.cwd(),
		model: { provider: "openai-codex", id: "gpt-5.5", input: ["text"] },
		modelRegistry: { getAll: () => [] },
	});
	assert.equal(rewritten, undefined);
}));
