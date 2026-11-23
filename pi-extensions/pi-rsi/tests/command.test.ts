import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext, type RegisteredCommand } from "@earendil-works/pi-coding-agent";
import rsiExtension from "../index.ts";
import { sandbox } from "./fixture.ts";

function harness(t: TestContext) {
	const root = sandbox(t);
	const directory = join(root, "agent/pi-rsi");
	const session = SessionManager.inMemory(root);
	let handle!: RegisteredCommand["handler"];
	rsiExtension({ registerCommand(name, options) { assert.equal(name, "rsi"); handle = options.handler; } } as ExtensionAPI);
	const notices: { message: string; level: string }[] = [];
	const ctx = {
		cwd: root, hasUI: true, mode: "tui", isIdle: () => true, sessionManager: session,
		ui: {
			custom: async (): Promise<string | undefined> => assert.fail("unexpected tree"),
			select: async (_title: string, _options: string[]): Promise<string | undefined> => assert.fail("unexpected selector"),
			editor: async (): Promise<string | undefined> => assert.fail("unexpected editor"),
			notify: (message: string, level: string) => notices.push({ message, level }),
		},
	};
	return {
		root, directory, session, ctx, notices,
		user: () => session.appendMessage({ role: "user", content: "instruction", timestamp: Date.now() }),
		assistant: (text: string, stopReason: "stop" | "aborted" = "stop") => session.appendMessage({
			role: "assistant", api: "openai-responses", provider: "openai", model: "fixture", timestamp: Date.now(),
			content: [{ type: "text", text }], stopReason,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		}),
		run: (args: string) => handle(args, ctx as unknown as ExtensionCommandContext),
		records: () => readdirSync(directory).map(file => JSON.parse(readFileSync(join(directory, file), "utf8"))),
	};
}

test("direct feedback targets the latest user on the active branch, not the leaf or an abandoned branch", async t => {
	const h = harness(t);
	h.user();
	const target = h.user();
	h.user(); // A later instruction on a different branch.
	h.session.branch(target);
	h.session.appendMessage({ role: "toolResult", toolCallId: "call", toolName: "read", content: [], isError: false, timestamp: Date.now() });
	const final = h.assistant("实际返回的回答");
	h.session.appendCustomEntry("metadata", {});
	await h.run("bad  没有验证   输入\n也没运行测试  ");
	const records = h.records();
	assert.equal(records.length, 1);
	const { id, createdAt, ...feedback } = records[0];
	assert.deepEqual(feedback, {
		sessionId: h.session.getSessionId(), userMessageEntryId: target, finalAssistantEntryId: final, projectPath: h.root,
		feedback: "bad", description: "没有验证   输入\n也没运行测试",
	});
	assert.equal(h.notices.at(-1)?.level, "info");
});

test("the form snapshots its target before selection and submits an empty description without a field", async t => {
	const h = harness(t);
	const target = h.user();
	const sessionId = h.session.getSessionId();
	h.ctx.ui.select = async () => {
		h.session.newSession();
		h.user();
		h.ctx.cwd = join(h.root, "other-project");
		return "good";
	};
	h.ctx.ui.editor = async () => "   ";
	await h.run("");
	const [record] = h.records();
	assert.equal(record.sessionId, sessionId);
	assert.equal(record.userMessageEntryId, target);
	assert.equal(record.finalAssistantEntryId, null);
	assert.equal(record.projectPath, h.root);
	assert.equal(record.feedback, "good");
	assert.equal("description" in record, false);
});

test("no user, invalid rating, or cancellation at either dialog leaves no files", async t => {
	const h = harness(t);
	await h.run("");
	assert.match(h.notices.at(-1)!.message, /没有可评价/);
	h.user();
	await h.run("goodish not a rating");
	assert.match(h.notices.at(-1)!.message, /用法/);
	h.ctx.ui.select = async () => undefined;
	await h.run("");
	h.ctx.ui.select = async () => "bad";
	h.ctx.ui.editor = async () => undefined;
	await h.run("");
	assert.equal(existsSync(h.directory), false);
	assert.equal(h.notices.some(notice => notice.level === "info"), false);
});

test("interrupting after partial output still allows feedback without a final assistant ID", async t => {
	const h = harness(t);
	h.user();
	h.assistant("previous answer");
	const interrupted = h.user();
	h.assistant("partial text…", "aborted");
	await h.run("bad 打断了执行");
	const [record] = h.records();
	assert.equal(record.userMessageEntryId, interrupted);
	assert.equal(record.finalAssistantEntryId, null);
	assert.equal(record.description, "打断了执行");
});

test("/rsi tree saves the selected off-branch answer without navigating or writing session entries", async t => {
	const h = harness(t);
	const userId = h.user();
	const firstAnswer = h.assistant("相同开头的回答");
	h.user();
	const otherRun = h.assistant("下一条指令的回答");
	h.session.branch(userId);
	const secondAnswer = h.assistant("相同开头的回答");
	const leaf = h.session.getLeafId();
	const before = h.session.getEntryCount();
	h.ctx.ui.custom = async () => userId;
	h.ctx.ui.select = async (_title, options) => {
		if (options.includes("bad")) return "bad";
		assert.equal(options.length, 2);
		assert.ok(options.some(option => option.includes(secondAnswer)));
		assert.ok(options.every(option => !option.includes(otherRun)));
		const first = options.find(option => option.includes(firstAnswer));
		assert.ok(first);
		return first;
	};
	h.ctx.ui.editor = async () => "";
	await h.run("tree");
	const [record] = h.records();
	assert.equal(record.feedback, "bad");
	assert.equal(record.userMessageEntryId, userId);
	assert.equal(record.finalAssistantEntryId, firstAnswer);
	assert.equal(h.session.getLeafId(), leaf);
	assert.equal(h.session.getEntryCount(), before);
});

test("tree target, session and project come from the snapshot taken before the first dialog", async t => {
	const h = harness(t);
	const user = h.user();
	const session = h.session.getSessionId();
	const final = h.assistant("old answer");
	h.ctx.ui.custom = async () => {
		h.session.newSession();
		h.ctx.cwd = join(h.root, "other");
		h.user();
		h.assistant("new answer");
		return user;
	};
	h.ctx.ui.select = async (_title, options) => {
		assert.deepEqual(options, ["good", "bad"]);
		return "good";
	};
	h.ctx.ui.editor = async () => "  初次答复  ";
	await h.run("tree");
	const [record] = h.records();
	assert.equal(record.sessionId, session);
	assert.equal(record.projectPath, h.root);
	assert.equal(record.userMessageEntryId, user);
	assert.equal(record.finalAssistantEntryId, final);
	assert.equal(record.description, "初次答复");
});

test("tree cancel, outcome cancel, or tree in RPC does not accidentally rate the latest user", async t => {
	const h = harness(t);
	const userId = h.user();
	h.assistant("done");
	h.session.branch(userId);
	h.assistant("partial", "aborted");
	h.ctx.ui.custom = async () => undefined;
	await h.run("tree");
	h.ctx.ui.custom = async () => userId;
	h.ctx.ui.select = async (_title, options) => {
		assert.equal(options.length, 2);
		assert.ok(!options.includes("bad"));
		return undefined;
	};
	await h.run("tree");
	h.ctx.mode = "rpc";
	h.ctx.ui.custom = async () => assert.fail("RPC cannot display a terminal component");
	await h.run("tree");
	assert.match(h.notices.at(-1)!.message, /TUI/);
	assert.equal(existsSync(h.directory), false);
});

test("without a UI, bare command shows usage and rating alone submits with no description", async t => {
	const h = harness(t);
	h.user();
	h.ctx.hasUI = false;
	const stderr = t.mock.method(console, "error", () => {});
	await h.run("");
	assert.equal(existsSync(h.directory), false);
	assert.match(stderr.mock.calls[0].arguments[0], /用法/);
	await h.run("good");
	const [record] = h.records();
	assert.equal(record.feedback, "good");
	assert.equal("description" in record, false);
});

test("unwritable destination reports failure rather than acknowledging feedback", async t => {
	const h = harness(t);
	h.user();
	mkdirSync(join(h.root, "agent"));
	writeFileSync(h.directory, "not a directory");
	await h.run("bad");
	assert.deepEqual(h.notices.map(n => n.level), ["error"]);
	assert.match(h.notices[0].message, /保存失败/);
	assert.equal(readFileSync(h.directory, "utf8"), "not a directory");
});
