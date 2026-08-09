import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	applyFastModeServiceTier,
	registerFastMode,
	resolveFastModeServiceTier,
} from "../src/fast-mode.js";
import { DEFAULT_SETTINGS, loadSettings } from "../src/settings.js";

function withAgentDir<T>(fn: (agentDir: string) => Promise<T> | T): Promise<T> | T {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const root = mkdtempSync(join(tmpdir(), "pi-codex-fast-mode-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const cleanup = () => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	};
	try {
		const result = fn(agentDir);
		if (result instanceof Promise) return result.finally(cleanup);
		cleanup();
		return result;
	} catch (error) {
		cleanup();
		throw error;
	}
}

test("Fast mode applies only to native OpenAI GPT-5 models and preserves explicit tiers", () => {
	const settings = { ...DEFAULT_SETTINGS, fastMode: true };
	assert.equal(resolveFastModeServiceTier(settings, { provider: "openai", id: "gpt-5.6-sol" }), "priority");
	assert.equal(resolveFastModeServiceTier(settings, { provider: "openai-codex", id: "gpt-5.5" }), "priority");
	assert.equal(resolveFastModeServiceTier(settings, { provider: "openai", id: "gpt-4.1" }), undefined);
	assert.equal(resolveFastModeServiceTier(settings, { provider: "custom", id: "gpt-5.6-sol" }), undefined);

	const body = { model: "gpt-5.6-sol", input: [] };
	assert.deepEqual(
		applyFastModeServiceTier(body, settings, { provider: "openai", id: "gpt-5.6-sol" }),
		{ ...body, service_tier: "priority" },
	);
	const explicit = { ...body, service_tier: "flex" };
	assert.equal(
		applyFastModeServiceTier(explicit, settings, { provider: "openai", id: "gpt-5.6-sol" }),
		explicit,
	);
});

test("/fast persists on and off selections", async () => withAgentDir(async () => {
	const commands: Record<string, any> = {};
	const handlers: Record<string, Function[]> = {};
	const notifications: Array<{ message: string; level: string }> = [];
	const statuses: Array<string | undefined> = [];
	const pi = {
		registerCommand(name: string, command: any) {
			commands[name] = command;
		},
		on(event: string, handler: Function) {
			(handlers[event] ??= []).push(handler);
		},
	};
	registerFastMode(pi as any);
	const ctx = {
		cwd: process.cwd(),
		model: { provider: "openai", id: "gpt-5.6-sol" },
		ui: {
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
			setStatus(_key: string, value: string | undefined) {
				statuses.push(value);
			},
		},
	};

	await commands.fast.handler("on", ctx);
	assert.equal(loadSettings().fastMode, true);
	assert.equal(statuses.at(-1), "priority");

	await commands.fast.handler("off", ctx);
	assert.equal(loadSettings().fastMode, false);
	assert.equal(statuses.at(-1), undefined);

	await commands.fast.handler("status", ctx);
	assert.match(notifications.at(-1)?.message ?? "", /enabled: false/);
}));
