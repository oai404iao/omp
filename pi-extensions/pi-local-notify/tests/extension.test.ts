import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import localNotifyExtension from "../index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function harness(t: TestContext) {
	const handlers: Record<string, Handler> = {};
	const commands: Record<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }> = {};
	localNotifyExtension({
		on(event: string, handler: Handler) { handlers[event] = handler; },
		registerCommand(name: string, command: typeof commands[string]) { commands[name] = command; },
	} as unknown as ExtensionAPI);

	const writes: string[] = [];
	const warnings: string[] = [];
	const originalWrite = process.stdout.write;
	const originalTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
	const originalEnv = process.env;
	process.env = { ...originalEnv, KITTY_WINDOW_ID: "1" };
	delete process.env.TMUX;
	delete process.env.TMUX_PANE;
	Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
	process.stdout.write = ((data: string) => { writes.push(data); return true; }) as typeof process.stdout.write;
	t.after(() => {
		process.stdout.write = originalWrite;
		if (originalTTY) Object.defineProperty(process.stdout, "isTTY", originalTTY);
		else Reflect.deleteProperty(process.stdout, "isTTY");
		process.env = originalEnv;
	});

	let branch: unknown[] = [];
	let entries: unknown[] = [];
	const ctx = {
		mode: "tui", cwd: "/work/project",
		sessionManager: { getBranch: () => branch, getEntries: () => entries },
		ui: { notify: (message: string) => warnings.push(message) },
	} as unknown as ExtensionContext;
	const emit = (event: string) => handlers[event]?.({}, ctx);
	const assistant = (id: string, stopReason = "stop") => ({
		type: "message", id, message: { role: "assistant", stopReason },
	});
	return {
		handlers, commands, ctx, emit, writes, warnings, assistant,
		setBranch(value: unknown[]) { branch = value; },
		setEntries(value: unknown[]) { entries = value; },
	};
}

test("only agent_settled notifies; active-branch results are deduplicated", (t) => {
	const h = harness(t);
	assert.equal(h.handlers.agent_end, undefined);
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
	await h.commands["local-notify-test"]!.handler("", h.ctx);
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
	await h.commands["local-notify-test"]!.handler("", h.ctx);
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
