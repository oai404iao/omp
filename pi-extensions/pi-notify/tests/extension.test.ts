import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { createEventBus, DefaultResourceLoader, ExtensionRunner, SessionManager, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import notifyExtension from "../index.ts";
import { configPath, notificationChannel } from "../src/settings.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
const scratch = process.env.TMPDIR || join(homedir(), ".local", "state", "agents", "tmp");
const telegram = { enabled: true, botToken: "FAKE_NEW_TOKEN", chatId: "FAKE_NEW_CHAT", requestTimeoutMs: 10_000 };
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function harness(t: TestContext) {
	const handlers: Record<string, Handler[]> = {};
	const commands: Record<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }> = {};
	const bus = createEventBus();
	const busCalls: string[] = [];
	notifyExtension({
		events: {
			emit(name: string, data: unknown) { busCalls.push(name); bus.emit(name, data); },
			on(name: string, handler: (data: unknown) => void) { busCalls.push(name); return bus.on(name, handler); },
		},
		on(event: string, handler: Handler) { (handlers[event] ??= []).push(handler); },
		registerCommand(name: string, command: typeof commands[string]) {
			assert.equal(commands[name], undefined, `duplicate command: ${name}`);
			commands[name] = command;
		},
	} as unknown as ExtensionAPI);

	const writes: string[] = [];
	const warnings: string[] = [];
	const originalWrite = process.stdout.write;
	const originalTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
	const originalEnv = process.env;
	mkdirSync(scratch, { recursive: true });
	const agentDir = mkdtempSync(join(scratch, "pi-notify-extension-"));
	process.env = { ...originalEnv, KITTY_WINDOW_ID: "1", PI_CODING_AGENT_DIR: agentDir };
	const localConfigDir = join(agentDir, "extensions", "pi-notify");
	const telegramConfigDir = join(agentDir, "extensions", "pi-telegram-notify");
	mkdirSync(localConfigDir, { recursive: true });
	mkdirSync(telegramConfigDir, { recursive: true });
	const legacyPath = join(telegramConfigDir, "config.json");
	writeFileSync(legacyPath, JSON.stringify({ botToken: "FAKE_LEGACY_TOKEN", chatId: "FAKE_LEGACY_CHAT" }));
	const originalFetch = globalThis.fetch;
	const requests: string[] = [];
	const urls: string[] = [];
	globalThis.fetch = (async (url, init) => {
		urls.push(String(url));
		requests.push(String(init?.body));
		return new Response(JSON.stringify({ ok: true }));
	}) as typeof fetch;
	delete process.env.TMUX;
	delete process.env.TMUX_PANE;
	Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
	process.stdout.write = ((data: string) => {
		if (typeof data === "string" && data.startsWith("\x1b")) {
			writes.push(data);
			return true;
		}
		return originalWrite.call(process.stdout, data);
	}) as typeof process.stdout.write;
	t.after(() => {
		process.stdout.write = originalWrite;
		if (originalTTY) Object.defineProperty(process.stdout, "isTTY", originalTTY);
		else Reflect.deleteProperty(process.stdout, "isTTY");
		process.env = originalEnv;
		globalThis.fetch = originalFetch;
	});

	let branch: unknown[] = [];
	let entries: unknown[] = [];
	const ctx = {
		mode: "tui", hasUI: true, cwd: "/work/project",
		sessionManager: { getBranch: () => branch, getEntries: () => entries },
		ui: { notify: (message: string) => warnings.push(message) },
	} as unknown as ExtensionContext;
	const emit = (event: string, payload: Record<string, unknown> = {}) => {
		for (const handler of handlers[event] ?? []) {
			handler({ type: event, ...(event === "agent_settled" ? { aborted: false } : {}), ...payload }, ctx);
		}
	};
	const assistant = (id: string, stopReason = "stop") => ({
		type: "message", id, message: { role: "assistant", stopReason, content: [{ type: "text", text: "final summary" }] },
	});
	return {
		commands, ctx, emit, writes, warnings, assistant, requests, urls, agentDir, busCalls, legacyPath,
		configure(channel: unknown, settings: unknown = telegram) { writeFileSync(configPath(), JSON.stringify({ channel, telegram: settings })); },
		setBranch(value: unknown[]) { branch = value; },
		setEntries(value: unknown[]) { entries = value; },
	};
}

test("only agent_settled notifies; active-branch results are deduplicated", (t) => {
	const h = harness(t);
	h.setEntries([h.assistant("off-branch", "error")]);
	h.setBranch([h.assistant("final")]);
	h.emit("agent_end");
	assert.equal(h.writes.length, 0);
	h.emit("agent_settled");
	h.emit("agent_settled");
	assert.equal(h.writes.length, 1);
	assert.ok(h.writes[0]!.includes(Buffer.from("project: Ready for input").toString("base64")));
	h.setBranch([h.assistant("next", "length")]);
	h.emit("agent_settled");
	assert.equal(h.writes.length, 2);
});

test("final errors notify without leaking error details; aborted and intermediate runs do not", (t) => {
	const h = harness(t);
	for (const reason of ["aborted", "toolUse"]) {
		h.setBranch([h.assistant(reason, reason)]);
		h.emit("agent_settled");
	}
	h.setBranch([]);
	h.emit("agent_settled");
	assert.equal(h.writes.length, 0);
	h.setBranch([h.assistant("failure", "error")]);
	h.emit("agent_settled");
	assert.ok(h.writes[0]!.includes(Buffer.from("project: Stopped with an error").toString("base64")));
});

test("settled cancellation suppresses leftover error and stop messages, then normal runs notify", (t) => {
	const h = harness(t);
	for (const reason of ["error", "stop"]) {
		h.setBranch([h.assistant(`cancelled-${reason}`, reason)]);
		h.emit("agent_settled", { aborted: true });
	}
	assert.equal(h.writes.length, 0);
	h.setBranch([h.assistant("normal-error", "error")]);
	h.emit("agent_settled", { aborted: false });
	h.setBranch([h.assistant("normal-stop", "stop")]);
	h.emit("agent_settled", { aborted: false });
	assert.equal(h.writes.length, 2);
	assert.ok(h.writes[0]!.includes(Buffer.from("project: Stopped with an error").toString("base64")));
	assert.ok(h.writes[1]!.includes(Buffer.from("project: Ready for input").toString("base64")));
});

test("user and custom-message runs retain the same completion policy", (t) => {
	const h = harness(t);
	for (const messageType of ["user", "custom"]) {
		h.emit("before_agent_start", messageType === "user"
			? { messageType, prompt: "user task" }
			: { messageType, message: { role: "custom", customType: "test", content: "custom task", display: false, timestamp: 0 } });
		h.setBranch([h.assistant(messageType)]);
		h.emit("agent_settled");
	}
	assert.equal(h.writes.length, 2);
});

test("RPC, JSON, print, redirected output, and non-Kitty terminals stay silent", (t) => {
	const h = harness(t);
	h.setBranch([h.assistant("final")]);
	for (const mode of ["rpc", "json", "print"]) {
		h.ctx.mode = mode as ExtensionContext["mode"];
		h.emit("agent_settled");
	}
	h.ctx.mode = "tui";
	Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
	h.emit("agent_settled");
	Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
	delete process.env.KITTY_WINDOW_ID;
	h.emit("agent_settled");
	assert.equal(h.writes.length, 0);
});

test("late subagent descriptors suppress completion and test notifications", async (t) => {
	const h = harness(t);
	h.emit("session_start");
	h.setBranch([h.assistant("child-final")]);
	h.setEntries([{ type: "custom", customType: "pi-subagent/descriptor" }]);
	h.emit("agent_settled");
	await h.commands["notify-test"]!.handler("", h.ctx);
	assert.equal(h.writes.length, 0);
	assert.equal(h.warnings.length, 1);
});

test("session replacement resets deduplication", (t) => {
	const h = harness(t);
	h.setBranch([h.assistant("final")]);
	h.emit("agent_settled");
	h.emit("session_shutdown");
	h.emit("session_start");
	h.emit("agent_settled");
	assert.equal(h.writes.length, 2);
});

test("test command emits through tmux even when focused", async (t) => {
	const h = harness(t);
	process.env.TMUX = "/socket,1,0";
	await h.commands["notify-test"]!.handler("", h.ctx);
	assert.ok(h.writes[0]!.startsWith("\x1bPtmux;"));
	assert.match(h.writes[0]!, /o=always/);
	assert.equal(h.warnings.length, 0);
});

test("synchronous output failures do not interrupt Pi and can be retried", (t) => {
	const h = harness(t);
	h.setBranch([h.assistant("final")]);
	const write = process.stdout.write;
	process.stdout.write = () => { throw new Error("terminal closed"); };
	assert.doesNotThrow(() => h.emit("agent_settled"));
	process.stdout.write = write;
	h.emit("agent_settled");
	assert.equal(h.writes.length, 1);
});

test("channel defaults are local, malformed configuration never enables Telegram", (t) => {
	const h = harness(t);
	assert.equal(notificationChannel(), "local");
	for (const value of [null, [], "telegram", { channel: "unknown" }]) {
		writeFileSync(configPath(), JSON.stringify(value));
		assert.equal(notificationChannel(), "local");
	}
	writeFileSync(configPath(), "{");
	assert.equal(notificationChannel(), "local");
	h.emit("session_start");
	h.emit("before_agent_start", { messageType: "user", prompt: "private prompt" });
	h.setBranch([h.assistant("final")]);
	h.emit("agent_settled");
	assert.equal(h.writes.length, 1);
	assert.equal(h.requests.length, 0);
});

test("only legacy credentials leave the new Telegram channel silent", async (t) => {
	const h = harness(t);
	h.configure("both", {});
	h.emit("session_start");
	h.emit("before_agent_start", { messageType: "user", prompt: "task" });
	h.setBranch([h.assistant("final")]);
	h.emit("agent_settled");
	await h.commands.notify!.handler("test telegram", h.ctx);
	assert.equal(h.writes.length, 1);
	assert.equal(h.requests.length, 0);
	assert.deepEqual(h.busCalls, []);
	assert.deepEqual(Object.keys(h.commands).sort(), ["notify", "notify-test"]);
});

test("explicit tests obey channels, enabled, credentials and live child identity", async (t) => {
	const h = harness(t);
	for (const [channel, settings] of [
		["local", telegram], ["telegram", { ...telegram, enabled: false }],
		["both", { botToken: telegram.botToken }], ["both", { chatId: telegram.chatId }],
	] as const) {
		h.configure(channel, settings);
		await h.commands.notify!.handler("test telegram", h.ctx);
	}
	assert.equal(h.requests.length, 0);
	h.configure("telegram");
	await h.commands["notify-test"]!.handler("", h.ctx);
	assert.equal(h.requests.length, 0, "the local command never sends Telegram");
	assert.equal(h.writes.length, 0);
	await h.commands.notify!.handler("test telegram", h.ctx);
	assert.equal(h.requests.length, 1);
	h.setEntries([{ type: "custom", customType: "pi-subagent/descriptor" }]);
	await h.commands.notify!.handler("test telegram", h.ctx);
	assert.equal(h.requests.length, 1);
	assert.equal(h.writes.length, 0);
});

test("enabled false disables only Telegram, and delivery never writes configuration", async (t) => {
	const h = harness(t);
	h.configure("both", { ...telegram, enabled: false });
	const before = readFileSync(configPath(), "utf8");
	const legacyBefore = readFileSync(h.legacyPath, "utf8");
	h.emit("session_start");
	h.emit("before_agent_start", { messageType: "user", prompt: "task" });
	h.emit("ui_prompt_start", { title: "Question" });
	h.setBranch([h.assistant("final")]);
	h.emit("agent_settled");
	await h.commands.notify!.handler("", h.ctx);
	await h.commands.notify!.handler("test telegram", h.ctx);
	await h.commands["notify-test"]!.handler("", h.ctx);
	assert.equal(h.writes.length, 2);
	assert.equal(h.requests.length, 0);
	assert.equal(readFileSync(configPath(), "utf8"), before);
	assert.equal(readFileSync(h.legacyPath, "utf8"), legacyBefore);
	assert.deepEqual(readdirSync(join(h.agentDir, "extensions", "pi-notify")), ["config.json"]);
});

test("channel selection and dedupe reread the new configuration", (t) => {
	const h = harness(t);
	h.emit("session_start");
	for (const channel of ["local", "telegram", "both"]) {
		h.configure(channel);
		h.setBranch([h.assistant(channel)]);
		for (let attempt = 0; attempt < 2; attempt++) {
			h.emit("before_agent_start", { messageType: "user", prompt: "task" });
			h.emit("agent_settled");
		}
	}
	assert.equal(h.writes.length, 2);
	assert.equal(h.requests.length, 2);
	h.emit("session_shutdown");
	h.emit("session_start");
	h.emit("before_agent_start", { messageType: "user", prompt: "new session" });
	h.emit("agent_settled");
	assert.equal(h.writes.length, 3);
	assert.equal(h.requests.length, 3);
	assert.ok(h.urls.every(url => url.includes("FAKE_NEW_TOKEN")));
	assert.ok(h.requests.every(body => JSON.parse(body).chat_id === "FAKE_NEW_CHAT"));
});

test("both channels isolate output failures and rejected network requests", async (t) => {
	const h = harness(t);
	h.configure("both");
	h.emit("session_start");
	h.emit("before_agent_start", { messageType: "user", prompt: "task" });
	h.setBranch([h.assistant("first")]);
	const write = process.stdout.write;
	process.stdout.write = () => { throw new Error("closed terminal"); };
	assert.doesNotThrow(() => h.emit("agent_settled"));
	process.stdout.write = write;
	assert.equal(h.requests.length, 1);
	h.emit("agent_settled");
	assert.equal(h.writes.length, 1, "local send can retry without resending Telegram");
	globalThis.fetch = async () => { throw new Error("offline FAKE_NEW_TOKEN FAKE_NEW_CHAT"); };
	h.emit("before_agent_start", { messageType: "user", prompt: "task" });
	h.setBranch([h.assistant("second", "error")]);
	assert.doesNotThrow(() => h.emit("agent_settled"));
	await flush();
	assert.equal(h.writes.length, 2);
	await h.commands.notify!.handler("test telegram", h.ctx);
	assert.match(h.warnings.at(-1)!, /failed/i);
	assert.doesNotMatch(h.warnings.at(-1)!, /FAKE_NEW_TOKEN|FAKE_NEW_CHAT/);
});

test("Telegram retains user-only waiting and non-TUI completion, local stays terminal-only", async (t) => {
	const h = harness(t);
	h.configure("both");
	h.emit("session_start");
	h.emit("before_agent_start", { messageType: "custom" });
	h.emit("ui_prompt_start", { title: "custom dialog" });
	h.setBranch([h.assistant("custom")]);
	h.emit("agent_settled");
	assert.equal(h.writes.length, 1);
	assert.equal(h.requests.length, 0);
	for (const mode of ["rpc", "json", "print"]) {
		h.ctx.mode = mode as ExtensionContext["mode"];
		h.emit("before_agent_start", { messageType: "user", prompt: "user task" });
		h.setBranch([h.assistant(mode)]);
		h.emit("agent_settled");
	}
	assert.equal(h.writes.length, 1);
	assert.equal(h.requests.length, 3);
	h.emit("before_agent_start", { messageType: "user", prompt: "user task" });
	h.emit("ui_prompt_start", { title: "Question" });
	assert.equal(h.requests.length, 4);
	h.setEntries([{ type: "custom", customType: "pi-subagent/descriptor" }]);
	h.setBranch([h.assistant("child")]);
	h.emit("ui_prompt_start", { title: "child dialog" });
	h.emit("agent_settled");
	await h.commands.notify!.handler("test telegram", h.ctx);
	await h.commands["notify-test"]!.handler("", h.ctx);
	assert.equal(h.requests.length, 4);
	assert.equal(h.writes.length, 1);
});

test("Telegram tests obey channel selection and cancellation never sends on either channel", async (t) => {
	const h = harness(t);
	await h.commands.notify!.handler("test telegram", h.ctx);
	assert.equal(h.requests.length, 0);
	h.configure("both");
	h.emit("session_start");
	for (const reason of ["stop", "error"]) {
		h.emit("before_agent_start", { messageType: "user", prompt: "cancelled" });
		h.setBranch([h.assistant(reason, reason)]);
		h.emit("agent_settled", { aborted: true });
	}
	h.emit("session_shutdown");
	h.emit("ui_prompt_start", { title: "shutdown" });
	assert.equal(h.requests.length, 0);
	assert.equal(h.writes.length, 0);
});

test("Pi loads the package directory with its notification commands and configuration path", async (t) => {
	const h = harness(t);
	h.configure("both");
	const path = join(h.agentDir, "extensions", "pi-notify", "config.json");
	assert.equal(configPath(), path);
	const loader = new DefaultResourceLoader({
		cwd: h.agentDir, agentDir: h.agentDir,
		noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
		additionalExtensionPaths: [fileURLToPath(new URL("../", import.meta.url))],
	});
	await loader.reload();
	const loaded = loader.getExtensions();
	try {
		assert.deepEqual(loaded.errors, []);
		assert.equal(loaded.extensions.length, 1);
		const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, h.agentDir,
			SessionManager.inMemory(h.agentDir), {} as ModelRegistry);
		const commands = runner.getRegisteredCommands();
		assert.deepEqual(commands.map(command => command.name).sort(), ["notify", "notify-test"]);
		await commands.find(command => command.name === "notify")!.handler("", h.ctx as Parameters<typeof commands[number]["handler"]>[1]);
		assert.match(h.warnings.at(-1)!, /Notification channel: both/);
		assert.ok(h.warnings.at(-1)!.includes(path));
		assert.match(h.warnings.at(-1)!, /enabled.*true/i);
		assert.match(h.warnings.at(-1)!, /bot token.*configured|bot token.*present/i);
		assert.match(h.warnings.at(-1)!, /chat id.*configured|chat id.*present/i);
		assert.doesNotMatch(h.warnings.at(-1)!, /FAKE_NEW_TOKEN|FAKE_NEW_CHAT|FAKE_LEGACY/);
		assert.equal(h.requests.length, 0);
		assert.equal(h.writes.length, 0);
	} finally {
		loaded.runtime.invalidate();
	}
});

test("legacy directory alone exposes only its original commands and ignores the new channel", async (t) => {
	const h = harness(t);
	h.configure("local");
	const loader = new DefaultResourceLoader({
		cwd: h.agentDir, agentDir: h.agentDir,
		noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
		additionalExtensionPaths: [fileURLToPath(new URL("../../pi-telegram-notify/", import.meta.url))],
	});
	await loader.reload();
	const loaded = loader.getExtensions();
	try {
		assert.deepEqual(loaded.errors, []);
		assert.equal(loaded.extensions.length, 1);
		const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, h.agentDir,
			SessionManager.inMemory(h.agentDir), {} as ModelRegistry);
		const commands = runner.getRegisteredCommands();
		assert.deepEqual(commands.map(command => command.name).sort(), ["telegram-notify", "telegram-notify:test"]);
		await commands.find(command => command.name === "telegram-notify:test")!.handler("", h.ctx as Parameters<typeof commands[number]["handler"]>[1]);
		assert.equal(h.requests.length, 1);
		assert.ok(h.urls[0]!.includes("FAKE_LEGACY_TOKEN"));
		assert.equal(h.writes.length, 0);
	} finally {
		loaded.runtime.invalidate();
	}
});

test("real Pi directory loading preserves independent delivery in both orders and on reload", async (t) => {
	const h = harness(t);
	h.configure("both");
	const eventBus = createEventBus();
	const notifyPath = fileURLToPath(new URL("../", import.meta.url));
	const legacyPath = fileURLToPath(new URL("../../pi-telegram-notify/", import.meta.url));
	for (const paths of [[notifyPath, legacyPath], [legacyPath, notifyPath], [notifyPath, legacyPath]]) {
		const loader = new DefaultResourceLoader({
			cwd: h.agentDir, agentDir: h.agentDir, eventBus,
			noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
			additionalExtensionPaths: paths,
		});
		await loader.reload();
		const loaded = loader.getExtensions();
		assert.deepEqual(loaded.errors, []);
		const session = SessionManager.inMemory(h.agentDir);
		const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, h.agentDir, session, {} as ModelRegistry);
		const errors: string[] = [];
		runner.onError((error) => errors.push(error.error));
		runner.setUIContext(runner.getUIContext(), "rpc");
		try {
			const names = runner.getRegisteredCommands().map((command) => command.name);
			assert.deepEqual(names.sort(), ["notify", "notify-test", "telegram-notify", "telegram-notify:test"]);
			await runner.emit({ type: "session_start", reason: "reload" });
			await runner.emitBeforeAgentStart({ messageType: "user", prompt: "real runner task" }, { cwd: h.agentDir });
			await runner.emit({ type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm", title: "one dialog" });
			h.configure("local");
			await runner.emit({ type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm", title: "legacy still enabled" });
			h.configure("both");
			writeFileSync(h.legacyPath, JSON.stringify({ enabled: false, botToken: "FAKE_LEGACY_TOKEN", chatId: "FAKE_LEGACY_CHAT" }));
			await runner.emit({ type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm", title: "new still enabled" });
			writeFileSync(h.legacyPath, JSON.stringify({ botToken: "FAKE_LEGACY_TOKEN", chatId: "FAKE_LEGACY_CHAT" }));
			await runner.emit({ type: "session_shutdown", reason: "reload" });
			assert.deepEqual(errors, []);
		} finally {
			loaded.runtime.invalidate();
		}
	}
	assert.equal(h.requests.length, 12, "each runtime sends independently through both packages");
	assert.equal(h.urls.filter(url => url.includes("FAKE_NEW_TOKEN")).length, 6);
	assert.equal(h.urls.filter(url => url.includes("FAKE_LEGACY_TOKEN")).length, 6);
});
