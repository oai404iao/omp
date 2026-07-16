import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import codexMinimalTools from "../src/index.js";
import { hasOpenAiModelsLoaded } from "../src/activation.js";

function fakePi() {
	const handlers: Record<string, Function[]> = {};
	const tools: any[] = [];
	let activeTools = ["read", "bash"];
	return {
		activeTools,
		handlers,
		tools,
		registerCommand() {},
		registerProvider() {},
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

test("hasOpenAiModelsLoaded detects active or registry OpenAI models", () => {
	assert.equal(hasOpenAiModelsLoaded({ model: { provider: "anthropic", id: "claude" }, modelRegistry: { getAll: () => [] } }), false);
	assert.equal(hasOpenAiModelsLoaded({ model: { provider: "notopenai", id: "claude" }, modelRegistry: { getAll: () => [] } }), false);
	assert.equal(hasOpenAiModelsLoaded({ model: { provider: "openai-codex", id: "gpt-5.5" }, modelRegistry: { getAll: () => [] } }), true);
	assert.equal(hasOpenAiModelsLoaded({ modelRegistry: { getAll: () => [{ provider: "openai", id: "gpt-5.5" }] } }), true);
	assert.equal(hasOpenAiModelsLoaded({ modelRegistry: { find: (provider, id) => provider === "openai" && id === "gpt-5.2" ? { provider, id } : undefined } }), true);
});

test("extension does not register tools until OpenAI models are loaded", async () => withAgentDir(async () => {
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
	assert.ok(pi.activeTools.includes("apply_patch"));
	assert.equal(pi.activeTools.includes("web_search"), false);
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

test("before_provider_request rewrites web_search only for enabled GPT-5 Codex models", async () => withAgentDir(async (agentDir) => {
	writeConfig(agentDir, { webSearchEnabled: true });
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
	assert.deepEqual(rewritten.tools, [{ type: "web_search" }]);

	const notGpt5 = handler({ payload }, {
		cwd: process.cwd(),
		model: { provider: "openai-codex", id: "gpt-4.1", input: ["text"] },
		modelRegistry: { getAll: () => [] },
	});
	assert.equal(notGpt5, undefined);
}));
