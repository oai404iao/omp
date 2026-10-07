import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { installFastModeLifecycle, sessionFastMode } from "@oai404iao/pi-codex-runtime/internal/fast-mode-state";
import { loadModelSettings } from "@oai404iao/pi-codex-runtime/internal/model-catalog/runtime";
import {
	applyFastModeServiceTier,
	registerFastMode,
	resolveFastModeServiceTier,
} from "@oai404iao/pi-codex-core/internal/fast-mode";
import { configPath, DEFAULT_SETTINGS, loadSettings, updateConfig } from "@oai404iao/pi-codex-runtime/internal/settings";

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

test("Fast mode follows exact model profiles and preserves explicit tiers", () => {
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

for (const defaultValue of [undefined, false, true]) test(`/fast keeps config default ${defaultValue} unchanged`, async () => withAgentDir(async () => {
	if (defaultValue !== undefined) updateConfig({ fastMode: defaultValue });
	const original = existsSync(configPath()) ? readFileSync(configPath(), "utf8") : undefined;
	const sessionManager = SessionManager.inMemory();
	const commands: Record<string, any> = {};
	const handlers: Record<string, Function[]> = {};
	const notifications: Array<{ message: string; level: string }> = [];
	const statuses: Array<string | undefined> = [];
	const pi = {
		appendEntry: (type: string, data: unknown) => sessionManager.appendCustomEntry(type, data),
		registerCommand(name: string, command: any) {
			commands[name] = command;
		},
		on(event: string, handler: Function) {
			(handlers[event] ??= []).push(handler);
		},
	};
	installFastModeLifecycle(pi as any);
	registerFastMode(pi as any);
	const ctx = {
		sessionManager,
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
	for (const handler of handlers.session_start ?? []) await handler({}, ctx);

	await commands.fast.handler("on", ctx);
	assert.equal(sessionFastMode(sessionManager.getSessionId(), false), true);
	assert.equal(statuses.at(-1), "priority");
	assert.equal(loadModelSettings(ctx.model, ctx.cwd, undefined, sessionManager.getSessionId()).fastMode, true);

	await commands.fast.handler("off", ctx);
	assert.equal(sessionFastMode(sessionManager.getSessionId(), true), false);
	assert.equal(statuses.at(-1), undefined);

	await commands.fast.handler("status", ctx);
	assert.match(notifications.at(-1)?.message ?? "", /enabled: false/);
	assert.match(notifications.at(-1)?.message ?? "", new RegExp(`config default: ${defaultValue ?? false}`));
	await commands.fast.handler("", ctx);
	assert.equal(sessionFastMode(sessionManager.getSessionId(), false), true);
	const count = sessionManager.getEntries().length;
	await commands.fast.handler("invalid", ctx);
	assert.equal(sessionManager.getEntries().length, count);
	assert.equal(notifications.at(-1)?.level, "warning");
	assert.equal(loadSettings().fastMode, defaultValue ?? false);
	assert.equal(existsSync(configPath()) ? readFileSync(configPath(), "utf8") : undefined, original);
	assert.deepEqual(sessionManager.buildSessionContext().messages, []);
	for (const handler of handlers.session_shutdown ?? []) await handler({}, ctx);
	assert.equal(sessionFastMode(sessionManager.getSessionId(), false), false);
}));
