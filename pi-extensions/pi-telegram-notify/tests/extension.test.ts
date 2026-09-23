import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createEventBus, DefaultResourceLoader, ExtensionRunner, SessionManager,
	type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import telegramNotifyExtension from "../index.js";

type ExtensionHandler = (event: any, ctx: any) => unknown;

function fakePi() {
	const handlers: Record<string, ExtensionHandler[]> = {};
	const commands: Record<string, { handler: (args: string, ctx: any) => Promise<void> }> = {};
	return {
		events: createEventBus(),
		handlers,
		commands,
		on(event: string, handler: ExtensionHandler) {
			(handlers[event] ??= []).push(handler);
		},
		registerCommand(name: string, command: typeof commands[string]) { commands[name] = command; },
	};
}

async function emit(pi: ReturnType<typeof fakePi>, event: string, ctx: any, payload: Record<string, unknown> = {}): Promise<void> {
	for (const handler of pi.handlers[event] ?? []) await handler(payload, ctx);
}

function assistantEntry(id: string, stopReason: string, text: string, parentId: string | null = null) {
	return {
		type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z",
		message: {
			role: "assistant", stopReason,
			content: text ? [{ type: "text", text }] : [],
			errorMessage: stopReason === "error" ? text : undefined,
		},
	};
}

function context(getBranch: () => unknown[], cwd = "/private/work/project", getEntries = getBranch) {
	return { cwd, hasUI: true, sessionManager: { getBranch, getEntries } };
}

interface Harness {
	pi: ReturnType<typeof fakePi>;
	requests: Array<{ url: string; text: string }>;
	agentDir: string;
}

async function withHarness(fn: (harness: Harness) => Promise<void>): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "pi-telegram-notify-extension-"));
	const agentDir = join(root, "agent");
	const configDir = join(agentDir, "extensions", "pi-telegram-notify");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(configDir, "config.json"), JSON.stringify({
		enabled: true, botToken: "000000:fake-test-token", chatId: "fake-test-chat", requestTimeoutMs: 1_000,
	}));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousFetch = globalThis.fetch;
	const requests: Array<{ url: string; text: string }> = [];
	process.env.PI_CODING_AGENT_DIR = agentDir;
	globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body)) as { text: string };
		requests.push({ url: String(url), text: body.text });
		return new Response(JSON.stringify({ ok: true }), { status: 200 });
	}) as typeof fetch;
	try {
		const pi = fakePi();
		telegramNotifyExtension(pi as any);
		await fn({ pi, requests, agentDir });
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		globalThis.fetch = previousFetch;
		rmSync(root, { recursive: true, force: true });
	}
}

function childDescriptor(provider = "spawn") {
	return {
		type: "custom", customType: "pi-subagent/descriptor",
		id: "descriptor", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", data: { provider },
	};
}

test("spawn and fork children never send completion, error, waiting, or test notifications", () => withHarness(async ({ pi, requests }) => {
	for (const provider of ["spawn", "fork"]) {
		const branch: unknown[] = [childDescriptor(provider)];
		const ctx = { ...context(() => branch), ui: { notify() {} } };
		await emit(pi, "session_start", ctx);
		await emit(pi, "before_agent_start", ctx, { prompt: "child task" });
		for (const stopReason of ["stop", "length", "error"]) {
			branch.push(assistantEntry(stopReason, stopReason, "child result"));
			await emit(pi, "agent_settled", ctx);
		}
		await emit(pi, "ui_prompt_start", ctx, { kind: "custom", title: "child question" });
		await pi.commands["telegram-notify"]!.handler("test", ctx);
		await pi.commands["telegram-notify:test"]!.handler("", ctx);
		await emit(pi, "session_shutdown", ctx);
	}
	assert.equal(requests.length, 0);
}));

test("checks child descriptors appended after startup at notification time", () => withHarness(async ({ pi, requests }) => {
	const branch: unknown[] = [];
	const ctx = context(() => branch);
	await emit(pi, "session_start", ctx);
	branch.push(childDescriptor(), assistantEntry("child-final", "stop", "silent child"));
	await emit(pi, "ui_prompt_start", ctx, { kind: "confirm", title: "child question" });
	await emit(pi, "agent_settled", ctx);
	assert.equal(requests.length, 0);
	await emit(pi, "session_shutdown", ctx);
	const parentCtx = { ...context(() => [assistantEntry("parent-final", "stop", "parent result")]), hasUI: false };
	await emit(pi, "session_start", parentCtx);
	await emit(pi, "agent_settled", parentCtx);
	assert.equal(requests.length, 1, "non-UI parent sessions still notify completion");
	assert.match(requests[0]!.text, /parent result/);
}));

test("child identity survives navigation before its descriptor", () => withHarness(async ({ pi, requests }) => {
	const branch = [assistantEntry("inherited-final", "stop", "inherited result")];
	const entries = [...branch, childDescriptor("fork")];
	const ctx = { ...context(() => branch, "/work/child", () => entries), ui: { notify() {} } };
	await emit(pi, "session_start", ctx);
	await emit(pi, "agent_settled", ctx);
	await emit(pi, "ui_prompt_start", ctx, { kind: "select", title: "still a child" });
	await pi.commands["telegram-notify:test"]!.handler("", ctx);
	assert.equal(requests.length, 0);
}));

test("agent_settled deduplicates the active-branch assistant and ignores intermediate retries", () => withHarness(async ({ pi, requests }) => {
	assert.equal(pi.handlers.agent_settled?.length, 1);
	assert.equal(pi.handlers.agent_end, undefined);
	let branch = [assistantEntry("retry-error", "error", "temporary provider failure")];
	const ctx = context(() => branch, "/private/work/project", () => [
		...branch, assistantEntry("off-branch", "error", "off-branch failure"),
	]);
	await emit(pi, "session_start", ctx);
	await emit(pi, "before_agent_start", ctx, { prompt: "implement the fix" });
	await emit(pi, "agent_end", ctx, { messages: [branch[0]!.message] });
	assert.equal(requests.length, 0);
	branch = [...branch, assistantEntry("retry-final", "stop", "active branch result", "retry-error")];
	await emit(pi, "agent_settled", ctx);
	await emit(pi, "agent_settled", ctx);
	assert.equal(requests.length, 1);
	assert.match(requests[0]!.text, /\*项目:\* `\/private\/work\/project`/);
	assert.match(requests[0]!.text, /\*状态:\* 完成/);
	assert.match(requests[0]!.text, /active branch result/);
	assert.doesNotMatch(requests[0]!.text, /temporary provider failure|off-branch failure/);
	await emit(pi, "session_shutdown", ctx, { reason: "reload" });
	await emit(pi, "session_start", ctx, { reason: "reload" });
	await emit(pi, "agent_settled", ctx);
	assert.equal(requests.length, 2);
}));

test("native prompt starts notify for all blocking extension dialogs, using title or fallback", () => withHarness(async ({ pi, requests }) => {
	const ctx = context(() => [], "/work/dialog");
	await emit(pi, "session_start", ctx);
	for (const kind of ["select", "confirm", "input", "editor", "custom"]) {
		await emit(pi, "ui_prompt_start", ctx, { reason: "ui_prompt", kind, title: `  ${kind} title  ` });
		await emit(pi, "ui_prompt_end", ctx, { reason: "ui_prompt" });
		assert.match(requests.at(-1)!.text, new RegExp(`${kind} title`));
		assert.match(requests.at(-1)!.text, /\*状态:\* 等待回复/);
		assert.match(requests.at(-1)!.text, /`\/work\/dialog`/);
	}
	assert.equal(requests.length, 5, "end notifications do not send Telegram messages");
	await emit(pi, "ui_prompt_start", ctx, { kind: "custom" });
	assert.match(requests.at(-1)!.text, /等待用户回复$/);
}));

test("tool preflight and legacy rpiv events no longer guess waiting or duplicate native notifications", () => withHarness(async ({ pi, requests }) => {
	const ctx = context(() => []);
	await emit(pi, "session_start", ctx);
	assert.equal(pi.handlers.tool_call, undefined);
	assert.equal(pi.handlers.tool_result, undefined);
	await emit(pi, "tool_call", ctx, { toolName: "ask_user_question", input: { question: "may be blocked" } });
	pi.events.emit("rpiv:ask-user:prompt", { questions: [{ question: "legacy summary" }] });
	assert.equal(requests.length, 0);
	await emit(pi, "ui_prompt_start", ctx, { kind: "custom" });
	pi.events.emit("rpiv:ask-user:prompt", { questions: [{ question: "legacy summary" }] });
	assert.equal(requests.length, 1);
	assert.doesNotMatch(requests[0]!.text, /legacy summary|may be blocked/);
}));

test("no waiting notification without UI or an active session; replacement uses its own cwd", () => withHarness(async ({ pi, requests }) => {
	const ctx = context(() => []);
	await emit(pi, "ui_prompt_start", ctx, { kind: "input" });
	await emit(pi, "session_start", ctx);
	await emit(pi, "ui_prompt_start", { ...ctx, hasUI: false }, { kind: "input" });
	await emit(pi, "session_shutdown", ctx);
	await emit(pi, "ui_prompt_start", ctx, { kind: "input" });
	assert.equal(requests.length, 0);
	const replacement = context(() => [], "/work/replacement");
	await emit(pi, "session_start", replacement);
	await emit(pi, "ui_prompt_start", replacement, { kind: "input", title: "Replacement" });
	assert.equal(requests.length, 1);
	assert.match(requests[0]!.text, /`\/work\/replacement`/);
}));

test("real Pi runner coalesces overlapping dialogs and closing after shutdown sends nothing", () => withHarness(async ({ agentDir, requests }) => {
	const loader = new DefaultResourceLoader({
		cwd: agentDir, agentDir, noExtensions: true, noSkills: true, noThemes: true,
		noPromptTemplates: true, noContextFiles: true, extensionFactories: [telegramNotifyExtension],
	});
	await loader.reload();
	const loaded = loader.getExtensions();
	assert.deepEqual(loaded.errors, []);
	const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, agentDir,
		SessionManager.inMemory(agentDir), {} as ModelRegistry);
	const errors: string[] = [];
	runner.onError((error) => errors.push(error.error));
	const finishes: Array<(value: boolean) => void> = [];
	runner.setUIContext({
		...runner.getUIContext(),
		confirm: () => new Promise<boolean>((resolve) => { finishes.push(resolve); }),
	}, "rpc");
	const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
	try {
		await runner.emit({ type: "session_start", reason: "startup" });
		const ui = runner.getUIContext();
		const first = ui.confirm("Outer dialog", "First");
		const overlapping = ui.confirm("Overlapping dialog", "Second");
		await flush();
		assert.equal(requests.length, 1);
		assert.match(requests[0]!.text, /Outer dialog/);
		finishes[0](true);
		await first;
		await flush();
		assert.equal(requests.length, 1);
		await runner.emit({ type: "session_shutdown", reason: "reload" });
		finishes[1](false);
		await overlapping;
		await flush();
		assert.equal(requests.length, 1);
		await runner.emit({ type: "session_start", reason: "reload" });
		const next = ui.confirm("Next span", "Third");
		await flush();
		assert.equal(requests.length, 2);
		assert.match(requests[1]!.text, /Next span/);
		finishes[2](true);
		await next;
		await flush();
		assert.deepEqual(errors, []);
	} finally {
		for (const finish of finishes) finish(false);
		await flush();
		await runner.emit({ type: "session_shutdown", reason: "quit" });
		loaded.runtime.invalidate();
	}
}));
