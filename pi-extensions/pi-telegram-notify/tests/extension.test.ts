import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import telegramNotifyExtension from "../src/index.js";

type ExtensionHandler = (event: any, ctx: any) => unknown;

class FakeEventBus {
	private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();

	on(channel: string, handler: (payload: unknown) => void): () => void {
		const channelListeners = this.listeners.get(channel) ?? new Set();
		channelListeners.add(handler);
		this.listeners.set(channel, channelListeners);
		return () => {
			channelListeners.delete(handler);
			if (channelListeners.size === 0) this.listeners.delete(channel);
		};
	}

	emit(channel: string, payload: unknown): void {
		for (const handler of this.listeners.get(channel) ?? []) handler(payload);
	}

	listenerCount(channel: string): number {
		return this.listeners.get(channel)?.size ?? 0;
	}
}

function fakePi() {
	const handlers: Record<string, ExtensionHandler[]> = {};
	const events = new FakeEventBus();
	return {
		events,
		handlers,
		on(event: string, handler: ExtensionHandler) {
			(handlers[event] ??= []).push(handler);
		},
		registerCommand() {},
	};
}

async function emit(pi: ReturnType<typeof fakePi>, event: string, ctx: any, payload: Record<string, unknown> = {}): Promise<void> {
	for (const handler of pi.handlers[event] ?? []) await handler(payload, ctx);
}

function assistantEntry(id: string, stopReason: string, text: string, parentId: string | null = null) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: {
			role: "assistant",
			stopReason,
			content: text ? [{ type: "text", text }] : [],
			errorMessage: stopReason === "error" ? text : undefined,
		},
	};
}

function context(getBranch: () => unknown[], cwd = "/private/work/project") {
	return {
		cwd,
		hasUI: true,
		sessionManager: {
			getBranch,
			getEntries(): never {
				throw new Error("the extension must not inspect all session entries");
			},
		},
	};
}

interface Harness {
	pi: ReturnType<typeof fakePi>;
	requests: Array<{ url: string; text: string }>;
}

async function withHarness(fn: (harness: Harness) => Promise<void>): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "pi-telegram-notify-extension-"));
	const agentDir = join(root, "agent");
	const configDir = join(agentDir, "extensions", "pi-telegram-notify");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(configDir, "config.json"), JSON.stringify({
		enabled: true,
		botToken: "000000:fake-test-token",
		chatId: "fake-test-chat",
		requestTimeoutMs: 1_000,
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
		await fn({ pi, requests });
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		globalThis.fetch = previousFetch;
		rmSync(root, { recursive: true, force: true });
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("registers agent_settled without agent_end and deduplicates the active-branch assistant entry", () => withHarness(async ({ pi, requests }) => {
	assert.equal(pi.handlers.agent_settled?.length, 1);
	assert.equal(pi.handlers.agent_end, undefined);

	const activeAssistant = assistantEntry("active-final", "stop", "active branch result", "model");
	const branch = [
		assistantEntry("earlier-error", "error", "retry me"),
		{ type: "model_change", id: "model", parentId: "earlier-error", timestamp: "2026-01-01T00:00:01.000Z" },
		activeAssistant,
		{ type: "label", id: "label", parentId: activeAssistant.id, timestamp: "2026-01-01T00:00:02.000Z" },
	];
	const ctx = context(() => branch);

	await emit(pi, "session_start", ctx, { reason: "startup" });
	await emit(pi, "before_agent_start", ctx, { prompt: "implement the fix" });
	await emit(pi, "agent_settled", ctx);
	await emit(pi, "agent_settled", ctx);

	assert.equal(requests.length, 1);
	assert.match(requests[0]!.text, /项目: \/private\/work\/project/);
	assert.match(requests[0]!.text, /状态: 完成/);
	assert.match(requests[0]!.text, /active branch result/);

	await emit(pi, "session_shutdown", ctx, { reason: "reload" });
	await emit(pi, "session_start", ctx, { reason: "reload" });
	await emit(pi, "agent_settled", ctx);
	assert.equal(requests.length, 2, "session lifecycle resets entry-id deduplication");
}));

test("does not notify an intermediate retry error and settled reports only the final result", () => withHarness(async ({ pi, requests }) => {
	let branch = [assistantEntry("retry-error", "error", "temporary provider failure")];
	const ctx = context(() => branch);
	await emit(pi, "session_start", ctx, { reason: "startup" });

	await emit(pi, "agent_end", ctx, { messages: [branch[0]!.message] });
	assert.equal(requests.length, 0);
	assert.equal(pi.handlers.agent_end, undefined);

	branch = [
		...branch,
		assistantEntry("retry-final", "stop", "retry eventually succeeded", "retry-error"),
	];
	await emit(pi, "agent_settled", ctx);

	assert.equal(requests.length, 1);
	assert.match(requests[0]!.text, /状态: 完成/);
	assert.match(requests[0]!.text, /retry eventually succeeded/);
	assert.doesNotMatch(requests[0]!.text, /temporary provider failure/);
}));

test("concurrent ask-user aliases consume one pending per rpiv by exact match then FIFO", () => withHarness(async ({ pi, requests }) => {
	const firstCtx = context(() => [], "/private/work/first-alias");
	const secondCtx = context(() => [], "/private/work/second-alias");
	await emit(pi, "session_start", firstCtx, { reason: "startup" });

	await emit(pi, "tool_call", firstCtx, {
		toolName: "ask_user_question",
		toolCallId: "question-1",
		input: { question: "first question" },
	});
	await emit(pi, "tool_call", secondCtx, {
		toolName: "ask-user-question",
		toolCallId: "question-2",
		input: { questions: [{ question: "second question" }] },
	});

	// Reverse event order to verify exact-summary matching takes precedence over
	// FIFO, then use an unmatched summary to consume the one remaining oldest call.
	pi.events.emit("rpiv:ask-user:prompt", { questions: [{ question: "second question" }] });
	pi.events.emit("rpiv:ask-user:prompt", { questions: [{ question: "authoritative first" }] });
	await delay(150);

	assert.equal(requests.length, 2);
	assert.match(requests[0]!.text, /状态: 等待回复/);
	assert.match(requests[0]!.text, /项目: \/private\/work\/second-alias/);
	assert.match(requests[0]!.text, /second question/);
	assert.match(requests[1]!.text, /项目: \/private\/work\/first-alias/);
	assert.match(requests[1]!.text, /authoritative first/);

	pi.events.emit("rpiv:ask-user:prompt", { questions: [{ question: "authoritative without pending" }] });
	assert.equal(requests.length, 3, "an authoritative event without a pending fallback still notifies");
	assert.match(requests[2]!.text, /authoritative without pending/);
}));

test("an unmatched rpiv event consumes only the oldest concurrent pending call", () => withHarness(async ({ pi, requests }) => {
	const oldestCtx = context(() => [], "/private/work/oldest");
	const newerCtx = context(() => [], "/private/work/newer");
	await emit(pi, "session_start", oldestCtx, { reason: "startup" });

	await emit(pi, "tool_call", oldestCtx, {
		toolName: "ask_user_question",
		toolCallId: "oldest-question",
		input: { question: "oldest fallback" },
	});
	await emit(pi, "tool_call", newerCtx, {
		toolName: "ask-user-question",
		toolCallId: "newer-question",
		input: { questions: [{ question: "newer fallback" }] },
	});

	pi.events.emit("rpiv:ask-user:prompt", { questions: [{ question: "unmatched authoritative" }] });
	await delay(150);

	assert.equal(requests.length, 2);
	assert.match(requests[0]!.text, /项目: \/private\/work\/oldest/);
	assert.match(requests[0]!.text, /unmatched authoritative/);
	assert.match(requests[1]!.text, /项目: \/private\/work\/newer/);
	assert.match(requests[1]!.text, /newer fallback/);
}));

test("late rpiv suppresses only its sent fallback and leaves another question pending", () => withHarness(async ({ pi, requests }) => {
	const sentCtx = context(() => [], "/private/work/sent-fallback");
	const pendingCtx = context(() => [], "/private/work/still-pending");
	await emit(pi, "session_start", sentCtx, { reason: "startup" });

	await emit(pi, "tool_call", sentCtx, {
		toolName: "ask_user_question",
		toolCallId: "sent-question",
		input: { question: "fallback already sent" },
	});
	await delay(150);
	assert.equal(requests.length, 1);
	assert.match(requests[0]!.text, /项目: \/private\/work\/sent-fallback/);
	assert.match(requests[0]!.text, /fallback already sent/);

	await emit(pi, "tool_call", pendingCtx, {
		toolName: "ask-user-question",
		toolCallId: "pending-question",
		input: { questions: [{ question: "pending authoritative" }] },
	});
	pi.events.emit("rpiv:ask-user:prompt", { questions: [{ question: "fallback already sent" }] });
	await delay(10);
	assert.equal(requests.length, 1, "a late authoritative event must not duplicate its sent fallback");

	pi.events.emit("rpiv:ask-user:prompt", { questions: [{ question: "pending authoritative" }] });
	await delay(150);
	assert.equal(requests.length, 2, "the other pending question must emit exactly once");
	assert.match(requests[1]!.text, /项目: \/private\/work\/still-pending/);
	assert.match(requests[1]!.text, /pending authoritative/);
}));

test("tool_result and session_shutdown cancel ask-user fallback timers", () => withHarness(async ({ pi, requests }) => {
	const ctx = context(() => []);
	await emit(pi, "session_start", ctx, { reason: "startup" });

	await emit(pi, "tool_call", ctx, {
		toolName: "ask_user_question",
		toolCallId: "completed-question",
		input: { question: "do not send after result" },
	});
	await emit(pi, "tool_result", ctx, { toolCallId: "completed-question" });
	await delay(150);
	assert.equal(requests.length, 0);

	await emit(pi, "tool_call", ctx, {
		toolName: "ask_user_question",
		toolCallId: "shutdown-question",
		input: { question: "do not send after shutdown" },
	});
	await emit(pi, "tool_call", ctx, {
		toolName: "ask-user-question",
		toolCallId: "second-shutdown-question",
		input: { questions: [{ question: "also clear on shutdown" }] },
	});
	await emit(pi, "session_shutdown", ctx, { reason: "reload" });
	await delay(150);
	assert.equal(requests.length, 0);
}));

test("ask-user fallback timer does not keep the Pi process alive", () => withHarness(async ({ pi }) => {
	const ctx = context(() => []);
	await emit(pi, "session_start", ctx, { reason: "startup" });

	const originalSetTimeout = globalThis.setTimeout;
	let fallbackTimer: NodeJS.Timeout | undefined;
	globalThis.setTimeout = ((handler: (...args: any[]) => void, timeout?: number, ...args: any[]) => {
		const timer = originalSetTimeout(handler, timeout, ...args);
		if (timeout === 100) fallbackTimer = timer;
		return timer;
	}) as typeof setTimeout;
	try {
		await emit(pi, "tool_call", ctx, {
			toolName: "ask_user_question",
			toolCallId: "unref-question",
			input: { question: "timer should be unreferenced" },
		});
	} finally {
		globalThis.setTimeout = originalSetTimeout;
	}

	assert.ok(fallbackTimer);
	assert.equal(fallbackTimer.hasRef(), false);
	await emit(pi, "tool_result", ctx, { toolCallId: "unref-question" });
}));

test("rpiv event subscription follows the session lifecycle and unsubscribes on shutdown", () => withHarness(async ({ pi, requests }) => {
	const channel = "rpiv:ask-user:prompt";
	const ctx = context(() => []);
	assert.equal(pi.events.listenerCount(channel), 0);

	await emit(pi, "session_start", ctx, { reason: "startup" });
	assert.equal(pi.events.listenerCount(channel), 1);
	await emit(pi, "session_start", ctx, { reason: "reload" });
	assert.equal(pi.events.listenerCount(channel), 1);

	await emit(pi, "session_shutdown", ctx, { reason: "reload" });
	assert.equal(pi.events.listenerCount(channel), 0);
	pi.events.emit(channel, { questions: [{ question: "stale closure" }] });
	await delay(10);
	assert.equal(requests.length, 0);
}));
