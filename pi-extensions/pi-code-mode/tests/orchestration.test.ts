import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DISCOVER, registerCodeModeTools, registerCodeModePolicy, type Discovery, type CodeModeTool, type CodeModePolicy } from "../src/contributions.ts";
import { collect } from "../src/catalog.ts";
import { ToolBridge, jsonValue } from "../src/bridge.ts";
import { UsageLedger } from "../src/usage.ts";
import { Cell } from "../src/cell.ts";
import { Scheduler } from "../src/scheduler.ts";
import { CodeSession } from "../src/session.ts";
import { UnsettledEffect } from "../src/process.ts";
import { Runtime } from "../src/runtime.ts";

const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
	cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } };
const schema = Type.Object({ value: Type.Integer() }, { additionalProperties: false });
const tool: CodeModeTool = { name: "echo", effect: "read", parallel: true, description: "fixture", parameters: schema,
	invoke: async (args) => ({ value: args as never, usage }) };
const signal = () => new AbortController().signal;

test("contributions: discovery is load-order independent, snapshots immutable, refresh/dispose explicit", () => {
	const pi = { events: createEventBus() } as unknown as ExtensionAPI;
	assert.deepEqual(collect(pi), { tools: [], policies: [], observers: [], approvals: [] });
	const first = registerCodeModeTools(pi, { id: "first", tools: [tool] });
	const snapshot = collect(pi);
	assert.equal(snapshot.tools[0].name, "first__echo");
	assert(Object.isFrozen(snapshot.tools[0].parameters));
	const second = registerCodeModeTools(pi, { id: "second", tools: [tool] });
	assert.equal(collect(pi).tools.length, 2);
	first.refresh([{ ...tool, description: "new contract" }]);
	assert.equal(snapshot.tools[0].description, "fixture");
	assert.equal(collect(pi).tools[0].description, "new contract");
	second.dispose(); first.dispose();
	assert.deepEqual(collect(pi).tools, []);
	assert.throws(() => first.refresh([]), /disposed/);
});

test("contributions: duplicates, invalid effects, discovery flood and policies fail closed", () => {
	const pi = { events: createEventBus() } as unknown as ExtensionAPI;
	const first = registerCodeModeTools(pi, { id: "same", tools: [tool] });
	const second = registerCodeModeTools(pi, { id: "same", tools: [tool] });
	assert.throws(() => collect(pi), /duplicate/);
	second.dispose(); first.refresh([{ ...tool, effect: "write", parallel: true }]);
	assert.throws(() => collect(pi), /Invalid/);
	first.dispose();
	const offFlood = pi.events.on(DISCOVER, (request) => {
		for (let i = 0; i < 33; i++) (request as Discovery).provider({ id: `p${i}`, tools: [] });
	});
	assert.throws(() => collect(pi), /budget/);
	offFlood();
	const offB = registerCodeModePolicy(pi, { id: "b", before: () => undefined });
	const offA = registerCodeModePolicy(pi, { id: "a", before: () => undefined });
	assert.deepEqual(collect(pi).policies.map((policy) => policy.id), ["a", "b"]);
	offA(); offB();
});

test("scheduler: an exclusive writer is a FIFO barrier for all nested tools", async () => {
	const scheduler = new Scheduler();
	const started: string[] = [];
	const finish: (() => void)[] = [];
	const read = (id: string) => scheduler.run(false, signal(), async () => {
		started.push(id); await new Promise<void>((resolve) => finish.push(resolve));
	});
	const reads = Array.from({ length: 4 }, (_, i) => read(`r${i}`));
	const writer = scheduler.run(true, signal(), async () => { started.push("write"); });
	const after = scheduler.run(false, signal(), async () => { started.push("after"); });
	for (const end of finish.slice(0, 3)) end();
	await new Promise((resolve) => setImmediate(resolve));
	assert(!started.includes("write"));
	finish[3]();
	await Promise.all([...reads, writer, after]);
	assert.deepEqual(started, ["r0", "r1", "r2", "r3", "write", "after"]);
});

test("policies: final frozen args, denial/throw/abort, redaction and usage accounting", async () => {
	let effects = 0;
	const ledger = new UsageLedger();
	const target = { ...tool, prepare: (args: unknown) => ({ value: Number((args as { value: unknown }).value) }),
		invoke: async () => { effects++; return { value: { secret: "fixture" }, usage }; } } satisfies CodeModeTool;
	const bridge = (policies: CodeModePolicy[], outer = signal()) => new ToolBridge([target], policies, "cell", ".", outer,
		() => undefined, (value) => ledger.add(value), () => {});
	for (const before of [() => ({ block: true as const }), () => { throw new Error("policy broken"); }]) {
		await assert.rejects(bridge([{ id: "guard", before }]).invoke("echo", { value: "1" }, "call", signal()));
	}
	assert.equal(effects, 0);
	const controller = new AbortController();
	const pending = bridge([{ id: "guard", before: () => new Promise(() => {}) }], controller.signal)
		.invoke("echo", { value: 1 }, "call", controller.signal);
	setTimeout(() => controller.abort(), 10);
	await assert.rejects(pending);
	assert.equal(effects, 0);
	const value = await bridge([{
		id: "guard", before: (call) => { assert(Object.isFrozen(call.input)); assert.deepEqual(call.input, { value: 1 }); },
		after: (_call, result) => { assert(Object.isFrozen(result)); return { redacted: true }; },
	}]).invoke("echo", { value: "1" }, "call", signal());
	assert.deepEqual(value, { redacted: true });
	assert.equal(effects, 1);
	assert.deepEqual(ledger.take(), usage);
	assert.equal(ledger.take(), undefined);
});

test("contributions: unsupported Pi controls are rejected, not silently dropped", async () => {
	const ledger = new UsageLedger();
	const bridge = new ToolBridge([{ ...tool, invoke: async () => ({ value: {}, usage, terminate: true }) }], [],
		"cell", ".", signal(), () => undefined, (value) => ledger.add(value), () => {});
	await assert.rejects(bridge.invoke("echo", { value: 1 }, "call", signal()), /controls must stay direct/);
	assert.deepEqual(ledger.take(), usage);
	assert.throws(() => jsonValue(new Date()), /plain JSON/);
	assert.throws(() => ledger.add({ ...usage, extra: "not allowed" } as never), /Invalid/);
});

test("cell: one observer, cancelled observation consumes nothing, output and usage delivered once", async () => {
	let finish!: () => void;
	const cell = new Cell(1000, async (current) => {
		await new Promise<void>((resolve) => { finish = resolve; });
		current.append("😀remaining"); current.usage.add(usage);
		return "completed";
	});
	const controller = new AbortController();
	const pending = cell.observe(1000, 8192, controller.signal);
	await assert.rejects(cell.observe(0, 8192), /already has an observer/);
	controller.abort();
	await assert.rejects(pending);
	finish(); await cell.finished;
	const first = await cell.observe(0, 1);
	assert.equal(first.text, "😀"); assert.equal(first.hasMoreOutput, true);
	assert.deepEqual(first.usage, usage);
	const second = await cell.observe(0, 8192);
	assert.equal(second.text, "remaining"); assert.equal(second.hasMoreOutput, false);
	assert.equal(second.usage, undefined);
});

test("cell: termination is not completion until side effects settle", async () => {
	let settle!: () => void;
	const cell = new Cell(1000, async () => {
		await new Promise<void>((resolve) => { settle = resolve; });
		return "terminated";
	});
	await new Promise((resolve) => setImmediate(resolve));
	cell.cancel("user requested", true);
	assert.equal((await cell.observe(0, 8192)).state, "terminating");
	settle(); await cell.finished;
	assert.equal((await cell.observe(0, 8192)).state, "terminated");
});

test("scheduler: unconfirmed process stop blocks the next queued side effect before releasing its slot", async () => {
	let effects = 0;
	const bridge = new ToolBridge([
		{ ...tool, name: "bad", effect: "process", parallel: false, invoke: async () => { throw new UnsettledEffect("not stopped"); } },
		{ ...tool, name: "next", effect: "write", parallel: false, invoke: async () => { effects++; return { value: {} }; } },
	], [], "cell", ".", signal(), () => undefined, () => {}, () => {});
	const first = bridge.invoke("bad", { value: 1 }, "first", signal());
	const second = bridge.invoke("next", { value: 1 }, "second", signal());
	await Promise.allSettled([first, second]);
	assert.equal(effects, 0);
	assert(bridge.unsettled);
});

test("cell: a running snapshot cannot consume a terminal result that arrived just after it", async () => {
	let fail!: () => void;
	const cell = new Cell(1000, async () => {
		await new Promise<void>((_, reject) => { fail = () => reject(new Error("late failure")); });
		return "completed";
	});
	const original = cell.observe.bind(cell);
	cell.observe = async (...args) => {
		const snapshot = await original(...args);
		fail(); await cell.finished;
		return snapshot;
	};
	const session = new CodeSession();
	Object.assign(session, { cells: new Map([[cell.id, cell]]) });
	const running = await session.wait(cell.id, { yield_time_ms: 0 });
	assert.equal(running.state, "running");
	assert.equal(session.activeCell?.id, cell.id);
	cell.observe = original;
	const terminal = await session.wait(cell.id, { yield_time_ms: 0 });
	assert.equal(terminal.state, "failed"); assert.equal(terminal.error, "late failure");
	assert.equal(session.activeCell, undefined);
});

test("contribution owner/tool encoding is injective and rejects ambiguous separators", () => {
	for (const provider of [{ id: "owner__db", tools: [tool] }, { id: "owner", tools: [{ ...tool, name: "db__read" }] }]) {
		const pi = { events: createEventBus() } as unknown as ExtensionAPI;
		registerCodeModeTools(pi, provider);
		assert.throws(() => collect(pi), /Invalid/);
	}
});

test("cell: output pagination preserves spaces, indentation and trailing newlines", async () => {
	const cell = new Cell(1000, async (current) => { current.append("abc def\n  end\n"); return "completed"; });
	await cell.finished;
	let text = "";
	let more: boolean;
	do {
		const observation = await cell.observe(0, 1);
		text += observation.text;
		more = observation.hasMoreOutput;
	} while (more);
	assert.equal(text, "abc def\n  end\n");
});

test("runtime: cancellation during effect settlement cannot become successful completion", async () => {
	const controller = new AbortController();
	const runtime = Object.create(Runtime.prototype) as Runtime;
	Object.assign(runtime, {
		active: new Set(), cells: new Map(), starts: Promise.resolve(), delegates: new Map(), delegateIds: new Set(),
		supervisor: { arm: async () => async () => {} },
		wire: { start: () => ({
			started: Promise.resolve({ type: "execution/started", cellId: "backend" }),
			initial: Promise.resolve({ Result: { cell_id: "backend", content_items: [], error_text: null } }),
		}) },
	});
	const bridge = new ToolBridge([], [], "cell", ".", controller.signal, () => undefined, () => {}, () => {});
	assert.equal(await runtime.run("text('done')", bridge, controller.signal, 1000, () => {},
		() => controller.abort(new Error("cancel during settlement"))), "terminated");
});

test("session: teardown audits late usage once and stays blocked", { timeout: 10000 }, async () => {
	let release!: () => void;
	const cell = new Cell(9000, async (current) => {
		await new Promise<void>((resolve) => { release = resolve; });
		current.usage.add(usage);
		return "terminated";
	});
	const session = new CodeSession();
	Object.assign(session, { cells: new Map([[cell.id, cell]]) });
	const audits: unknown[] = [];
	session.onDiscard = (receipt) => audits.push(receipt.usage);
	await assert.rejects(session.revoke(true), /settling/);
	release(); await cell.finished;
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(audits, [usage]);
	assert.equal(cell.usage.take(), undefined);
	assert.equal(session.enabled, false);
	await assert.rejects(session.wait(cell.id), /stale/);
});

test("session: teardown and an active observer cannot double-consume usage", async () => {
	let release!: () => void;
	const cell = new Cell(1000, async (current) => {
		await new Promise<void>((resolve) => { release = resolve; });
		current.usage.add(usage);
		return "terminated";
	});
	const session = new CodeSession();
	Object.assign(session, { cells: new Map([[cell.id, cell]]) });
	const audits: unknown[] = [];
	session.onDiscard = (receipt) => audits.push(receipt.usage);
	const observation = session.wait(cell.id, { yield_time_ms: 1000 });
	await new Promise((resolve) => setImmediate(resolve));
	const closing = session.revoke();
	release();
	const result = await observation;
	await closing;
	assert.deepEqual([...audits, ...(result.usage ? [result.usage] : [])], [usage]);
});
