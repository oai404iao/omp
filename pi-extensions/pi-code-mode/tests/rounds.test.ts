import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createCodeModeDirectBinding, registerCodeModeTools, registerCodeModePolicy, type CodeModeTool } from "../src/contributions.ts";
import { piSession, scratch } from "./helpers.ts";

const host = process.env.CODE_MODE_TEST_HOST;
assert(host, "CODE_MODE_TEST_HOST required; no silent integration skips");
process.env.XDG_STATE_HOME = await scratch("rounds-state");
const usage = { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10,
	cost: { input: 0.07, output: 0.03, cacheRead: 0, cacheWrite: 0, total: 0.1 } };
type Action = { name: string; arguments: Record<string, unknown> };
function transport(t: TestContext) {
	const queue: (Action | undefined)[] = [];
	const requests: Record<string, unknown>[] = [];
	let holdFinal = false, held = false;
	let resume = () => {};
	const original = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		assert.equal(new URL(request.url).origin, "https://s1-fixture.invalid");
		requests.push(await request.json() as Record<string, unknown>);
		assert(queue.length, "Unexpected model request");
		const action = queue.shift();
		if (!action && holdFinal) {
			held = true;
			// Fixture transport is explicitly released after abort; do not rely on
			// an HTTP SDK forwarding its signal to a monkey-patched fetch.
			await new Promise<void>((resolve) => { resume = resolve; });
		}
		const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({
			id: "s2", object: "chat.completion.chunk", created: 1, model: "s1",
			choices: [{ index: 0, delta, finish_reason }],
		})}\n\n`;
		const delta = action ? { role: "assistant", tool_calls: [{ index: 0, id: `call-${requests.length}`, type: "function",
			function: { name: action.name, arguments: JSON.stringify(action.arguments) } }] } : { role: "assistant", content: "Paused" };
		return new Response(chunk(delta, null) + chunk({}, action ? "tool_calls" : "stop") + "data: [DONE]\n\n",
			{ headers: { "content-type": "text/event-stream" } });
	};
	t.after(() => { resume(); globalThis.fetch = original; });
	return {
		requests,
		holdFinal() { holdFinal = true; },
		releaseFinal() { holdFinal = false; resume(); },
		get held() { return held; },
		async run(session: AgentSession, action: Action) {
			queue.push(action, undefined);
			await session.prompt("Run the requested Code Mode action.");
			assert.equal(queue.length, 0);
			const result = [...session.messages].reverse().find((message) => message.role === "toolResult");
			assert(result?.role === "toolResult");
			return result;
		},
	};
}
async function until(predicate: () => boolean) {
	for (let i = 0; i < 500 && !predicate(); i++) await delay(10);
	assert(predicate(), "Timed out waiting for integration condition");
}
const exec = (code: string): Action => ({ name: "exec", arguments: { code, yield_time_ms: 0 } });
const wait = (cell_id: string): Action => ({ name: "wait", arguments: { cell_id, yield_time_ms: 10000 } });
const cellId = (result: { details?: unknown }) => {
	const id = (result.details as { cellId?: string })?.cellId;
	assert(id);
	return id;
};

test("real Pi: cell survives normal agent_end, contribution context and usage delivered once across user prompts", { timeout: 20000 }, async (t) => {
	const http = transport(t);
	let release!: () => void, started = false, aborted = false;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const f = await piSession(t, { host, grant: true, tools: "fixture__work", factory: (pi) => {
		registerCodeModeTools(pi, { id: "fixture", tools: [{
			name: "work", description: "Controlled asynchronous contribution", parameters: Type.Object({}), effect: "read",
			async invoke(_input, ctx) {
				started = true;
				assert.equal(ctx.pi?.signal, ctx.signal);
				ctx.signal.addEventListener("abort", () => { aborted = true; }, { once: true });
				await gate;
				return { value: "across-user-prompts", usage };
			},
		}] });
	} });
	const first = await http.run(f.session, exec("text(await tools.fixture__work({}))"));
	const id = cellId(first);
	await until(() => started);
	assert.equal(aborted, false, "normal agent_end must not abort the cell");
	assert.equal(first.usage, undefined);
	release();
	const second = await http.run(f.session, wait(id));
	assert.equal(second.isError, false);
	assert.match(JSON.stringify(second.content), /across-user-prompts/);
	assert.deepEqual(second.usage, usage);
	const consumed = await http.run(f.session, wait(id));
	assert.equal(consumed.isError, true);
	assert.equal(consumed.usage, undefined);
	assert.equal(f.session.getSessionStats().tokens.total, 10, "nested usage reaches real Pi totals exactly once");
	assert.deepEqual(f.errors, []);
});

test("real Pi: refresh aborts old snapshot, stale IDs fail and new definition is model-visible", { timeout: 20000 }, async (t) => {
	const http = transport(t);
	let registration!: ReturnType<typeof registerCodeModeTools>, started = false, aborted = false;
	const replacement: CodeModeTool = { name: "work", description: "replacement-v2", parameters: Type.Object({}), effect: "read",
		async invoke() { return { value: "new-snapshot" }; } };
	const f = await piSession(t, { host, grant: true, tools: "fixture__work", factory: (pi) => {
		registration = registerCodeModeTools(pi, { id: "fixture", tools: [{ ...replacement, description: "old-v1",
			async invoke(_input, ctx) {
				started = true;
				await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
				return { value: "old-result", usage };
			},
		}] });
	} });
	const id = cellId(await http.run(f.session, exec("text(await tools.fixture__work({}))")));
	await until(() => started);
	registration.refresh([replacement]);
	await until(() => aborted && f.session.getAllTools().some((tool) => tool.name === "exec" && tool.description.includes("replacement-v2")));
	assert.equal((await http.run(f.session, wait(id))).isError, true);
	const next = await http.run(f.session, { name: "exec", arguments: { code: "text(await tools.fixture__work({}))", yield_time_ms: 10000 } });
	assert.match(JSON.stringify(next.content), /new-snapshot/);
	assert.match(JSON.stringify(http.requests.at(-2)?.tools), /replacement-v2/);
	const receipts = f.session.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "pi-code-mode:uncollected-usage/v1");
	assert.equal(receipts.length, 1);
	assert.equal(f.session.getSessionStats().tokens.total, 0, "audit receipt is not a fabricated tool result");
	registration.dispose();
	await until(() => !f.session.getAllTools().find((tool) => tool.name === "exec")?.description.includes("replacement-v2"));
});

test("real Pi: Esc after exec returns aborts the cross-turn contribution and preserves its usage", { timeout: 20000 }, async (t) => {
	const http = transport(t);
	let started = false, aborted = false;
	const f = await piSession(t, { host, grant: true, tools: "fixture__work", factory: (pi) => {
		registerCodeModeTools(pi, { id: "fixture", tools: [{
			name: "work", description: "Abort fixture", parameters: Type.Object({}), effect: "read",
			async invoke(_input, ctx) {
				started = true;
				await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
				return { value: "settled", usage };
			},
		}] });
	} });
	http.holdFinal();
	const pending = http.run(f.session, exec("text(await tools.fixture__work({}))"));
	await until(() => started && http.held);
	const abort = f.session.abort();
	http.releaseFinal();
	await abort;
	const first = await pending;
	await until(() => aborted);
	const terminal = await http.run(f.session, wait(cellId(first)));
	assert.equal(terminal.isError, true);
	assert.deepEqual(terminal.usage, usage);
	assert.match(JSON.stringify(terminal.content), /interrupted/);
});

test("real Pi: model switch, tree navigation and reload discard cells/store without replay", { timeout: 25000 }, async (t) => {
	const http = transport(t);
	const f = await piSession(t, { host, grant: true, maxCells: 2 });
	assert.equal((await http.run(f.session, { name: "exec", arguments: { code: "store('old', 1)", yield_time_ms: 10000 } })).isError, false);
	const old = cellId(await http.run(f.session, exec("await new Promise(() => {})")));
	const oldSibling = cellId(await http.run(f.session, exec("await new Promise(() => {})")));
	await f.session.setModel({ ...f.session.model!, id: "s2-switch" });
	assert.equal((await http.run(f.session, wait(old))).isError, true);
	assert.equal((await http.run(f.session, wait(oldSibling))).isError, true);
	const result = await http.run(f.session, { name: "exec", arguments: { code: "text(load('old') ?? 'empty')", yield_time_ms: 10000 } });
	assert.match(JSON.stringify(result.content), /empty/);
	const second = cellId(await http.run(f.session, exec("await new Promise(() => {})")));
	const secondSibling = cellId(await http.run(f.session, exec("await new Promise(() => {})")));
	const navigation = await f.session.navigateTree(f.session.getUserMessagesForForking()[0].entryId, { summarize: false });
	assert.equal(navigation.cancelled, false);
	assert.equal((await http.run(f.session, wait(second))).isError, true);
	assert.equal((await http.run(f.session, wait(secondSibling))).isError, true);
	const third = cellId(await http.run(f.session, exec("await new Promise(() => {})")));
	const thirdSibling = cellId(await http.run(f.session, exec("await new Promise(() => {})")));
	await f.session.reload();
	assert.equal((await http.run(f.session, wait(third))).isError, true);
	assert.equal((await http.run(f.session, wait(thirdSibling))).isError, true);
	assert.deepEqual(f.errors, []);
});

test("real Pi U4: two cells survive user turns; commands require a target and preserve unread receipts", { timeout: 20000 }, async (t) => {
	const http = transport(t);
	const f = await piSession(t, { host, grant: true, maxCells: 2 });
	const a = cellId(await http.run(f.session, exec("text('A'); await new Promise(()=>{})")));
	const b = cellId(await http.run(f.session, exec("text('B'); await new Promise(()=>{})")));
	await f.session.prompt("/code-mode cells");
	await f.session.prompt("/code-mode terminate");
	assert(f.errors.some((error) => error.includes("No unique")));
	await f.session.prompt(`/code-mode terminate ${a}`);
	const done = await http.run(f.session, wait(a));
	assert.equal(done.isError, false);
	assert.equal((done.details as { state: string }).state, "terminated");
	const pending = await http.run(f.session, { name: "wait", arguments: { cell_id: b, yield_time_ms: 0 } });
	assert.equal((pending.details as { state: string }).state, "running");
	await f.session.prompt("/code-mode terminate all");
	assert.equal((await http.run(f.session, wait(b))).isError, false);
	assert.equal((await http.run(f.session, wait(a))).isError, true);
});

test("real Pi: ungranted contribution is absent, policies block execution and redact before JavaScript", { timeout: 20000 }, async (t) => {
	const http = transport(t);
	let calls = 0;
	const f = await piSession(t, { host, grant: true, tools: "fixture__read", factory: (pi) => {
		const tool: CodeModeTool = { name: "read", description: "policy fixture", effect: "read", parameters: Type.Object({ deny: Type.Boolean() }),
			async invoke() { calls++; return { value: "secret" }; } };
		registerCodeModeTools(pi, { id: "fixture", tools: [tool, { ...tool, name: "hidden" }] });
		registerCodeModePolicy(pi, { id: "guard", before(call) {
			if ((call.input as { deny?: boolean }).deny) return { block: true, reason: "fixture denial" };
		}, after() { return "redacted"; } });
	} });
	const result = await http.run(f.session, { name: "exec", arguments: { yield_time_ms: 10000,
		code: "text(typeof tools.fixture__hidden); try { await tools.fixture__read({deny:true}) } catch { text('blocked') }; text(await tools.fixture__read({deny:false}))" } });
	assert.equal(result.isError, false);
	assert.match(JSON.stringify(result.content), /undefined.*blocked.*redacted/);
	assert.doesNotMatch(JSON.stringify(result.content), /secret/);
	assert.equal(calls, 1);
	assert.doesNotMatch(JSON.stringify(http.requests[0].tools), /fixture__hidden/);
});

test("real Pi: poisoned S2 invalidation restores S4 direct tools and never re-hides them", { timeout: 20000 }, async (t) => {
	const http = transport(t);
	let started = false, release!: () => void;
	let owner!: ReturnType<typeof createCodeModeDirectBinding>;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	t.after(() => release());
	const f = await piSession(t, { host, grant: true, visibility: "hide-bridged", tools: "fixture__work", factory: (pi) => {
		pi.registerTool({ name: "work", label: "Work", description: "Direct work", parameters: Type.Object({}),
			async execute() { return { content: [{ type: "text", text: "direct" }], details: {} }; } });
		owner = createCodeModeDirectBinding(pi, { name: "work", sourcePath: "<inline:1>" });
		registerCodeModeTools(pi, { id: "fixture", tools: [{
			name: "work", description: "Noncooperative fixture", parameters: Type.Object({}), effect: "read", direct: owner.binding,
			async invoke() { started = true; await gate; return { value: "late" }; },
		}] });
		pi.on("session_shutdown", () => owner.dispose());
	} });
	const first = await http.run(f.session, exec("text(await tools.fixture__work({}))"));
	await until(() => started);
	assert(!f.session.getActiveToolNames().includes("work"));
	await f.session.setModel({ ...f.session.model!, id: "s4-blocked" });
	assert(f.errors.some((error) => error.includes("settling")));
	assert(f.session.getActiveToolNames().includes("work"));
	release();
	owner.reconcile();
	assert(f.session.getActiveToolNames().includes("work"), "visibility event cannot undo blocked-session restoration");
	await f.session.navigateTree(f.session.getUserMessagesForForking()[0].entryId, { summarize: false });
	assert(f.session.getActiveToolNames().includes("work"), "failed tree invalidation must also retain restoration");
	await http.run(f.session, wait(cellId(first)));
	assert.equal((await http.run(f.session, exec("text('must not execute')"))).isError, true);
	assert(f.session.getActiveToolNames().includes("work"));
});
