import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { Runtime } from "../src/runtime.ts";
import { ToolBridge } from "../src/bridge.ts";
import { Scheduler } from "../src/scheduler.ts";
import { Wire } from "../src/wire.ts";
import { CodeSession } from "../src/session.ts";

function deferred<T>() {
	let resolve!: (value: T) => void, reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	void promise.catch(() => {});
	return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate: () => boolean) {
	for (let i = 0; i < 100 && !predicate(); i++) await tick();
	assert(predicate());
}
function fixture(options: { hold?: string; stopFails?: boolean; disarm?: () => Promise<void> } = {}) {
	const operations: { started: ReturnType<typeof deferred<unknown>>; initial: ReturnType<typeof deferred<unknown>> }[] = [];
	const sent: unknown[] = [], effects: string[] = [];
	const held = deferred<void>();
	const settling = new Set<string>();
	const bridges = new Map<string, ToolBridge>();
	const wire = {
		failure: undefined as Error | undefined, onFailure: (_error: Error) => {}, onCancel: (_id: number) => {},
		onDelegate: (_message: Record<string, unknown>) => {},
		fail(error: Error) {
			if (wire.failure) return;
			wire.failure = error; wire.onFailure(error);
			for (const operation of operations) { operation.started.reject(error); operation.initial.reject(error); }
		},
		start() {
			const operation = { started: deferred<unknown>(), initial: deferred<unknown>() };
			operations.push(operation);
			return { started: operation.started.promise, initial: operation.initial.promise };
		},
		async send(message: unknown) { sent.push(message); },
	};
	const runtime = Reflect.construct(Runtime, [{ async stop() { if (options.stopFails) throw Error("fixture stop unconfirmed"); }, async arm() { return options.disarm ?? (async () => {}); } }, wire, {}]) as Runtime;
	const bridge = (id: string) => new ToolBridge([{
		name: id, description: id, effect: "read", parallel: true, parameters: Type.Object({}),
		async invoke() { effects.push(id); if (options.hold === id) await held.promise; return { value: id }; },
	}], [], id, ".", new AbortController().signal, () => undefined, () => {}, () => {});
	const run = (id: string) => {
		const tools = bridge(id); bridges.set(id, tools);
		return runtime.run("fixture()", tools, new AbortController().signal, 1000, () => {}, () => { settling.add(id); });
	};
	const invoke = (cell: string, id: number, tool: string) => wire.onDelegate({
		id, sessionId: runtime.sessionId, request: { type: "tool/invoke", invocation: {
			cell_id: cell, tool_kind: "function", runtime_tool_call_id: `call${id}`, tool_name: { name: tool }, input: {},
		} },
	});
	const ack = (index: number, cellId: string) => operations[index].started.resolve({ type: "execution/started", cellId });
	const complete = (index: number, cell_id: string) => operations[index].initial.resolve({ Result: { cell_id, content_items: [], code_mode_host_duration_ns: 0 } });
	return { runtime, wire, operations, sent, effects, run, invoke, ack, complete, held, settling, bridges };
}

test("U4 protocol: serialize ACK registration, route pre-ACK delegates to their exact cells, allow concurrent execution", async () => {
	const f = fixture();
	const a = f.run("a"), b = f.run("b");
	await until(() => f.operations.length === 1);
	f.invoke("cell-a", 1, "a");
	await tick(); assert.deepEqual(f.effects, []);
	f.ack(0, "cell-a");
	await until(() => f.operations.length === 2);
	f.invoke("cell-b", 2, "b");
	await tick(); assert.deepEqual(f.effects, ["a"]);
	f.ack(1, "cell-b");
	await until(() => f.sent.length === 2);
	assert.deepEqual(f.effects, ["a", "b"]);
	f.complete(1, "cell-b"); assert.equal(await b, "completed");
	f.complete(0, "cell-a"); assert.equal(await a, "completed");
	assert.equal(f.wire.failure, undefined);
	await f.runtime.close();
});

test("U4 protocol: unknown early cell never binds to the last start; duplicate delegate IDs across cells fail closed", async () => {
	for (const duplicate of [false, true]) {
		const f = fixture();
		const a = f.run("a"), b = f.run("b");
		const settled = Promise.allSettled([a, b]);
		await until(() => f.operations.length === 1);
		if (!duplicate) f.invoke("wrong-cell", 1, "a");
		f.ack(0, "cell-a");
		if (duplicate) {
			await until(() => f.operations.length === 2);
			f.ack(1, "cell-b");
			await tick();
			f.invoke("cell-a", 7, "a");
			await until(() => f.sent.length === 1);
			f.invoke("cell-b", 7, "b");
		}
		const results = await settled;
		assert(results.every((value) => value.status === "rejected"));
		assert.match(f.wire.failure!.message, duplicate ? /delegate identity/ : /Wrong delegate cell/);
		assert.deepEqual(f.effects, duplicate ? ["a"] : []);
	}
});

test("U4 protocol: retired delegate IDs cannot be reused or receive another cell's late cancellation", async () => {
	const f = fixture();
	const a = f.run("a");
	await until(() => f.operations.length === 1);
	f.ack(0, "cell-a"); await tick(); f.invoke("cell-a", 7, "a");
	await until(() => f.sent.length === 1);
	f.complete(0, "cell-a"); await a;
	const b = f.run("b"); const rejected = assert.rejects(b, /delegate identity/);
	await until(() => f.operations.length === 2);
	f.ack(1, "cell-b"); await tick();
	f.invoke("cell-b", 7, "b"); f.wire.onCancel(7);
	await rejected; assert.deepEqual(f.effects, ["a"]);
});

test("U4 protocol: permit bounded out-of-order IDs but never accept expired unseen gaps", async () => {
	const f = fixture();
	const a = f.run("a");
	await until(() => f.operations.length === 1);
	f.ack(0, "cell-a"); await tick();
	f.invoke("cell-a", 10, "a"); f.invoke("cell-a", 9, "a");
	await until(() => f.sent.length === 2);
	f.complete(0, "cell-a"); await a;
	const b = f.run("b"); const rejected = assert.rejects(b, /reorder window/);
	await until(() => f.operations.length === 2);
	f.ack(1, "cell-b"); await tick(); f.invoke("cell-b", 4106, "b");
	await until(() => f.sent.length === 3);
	f.invoke("cell-b", 8, "b"); // never seen, but too old to distinguish from replay
	await rejected; assert.deepEqual(f.effects, ["a", "a", "b"]);
});

test("U4 protocol: settling siblings inherit shared runtime loss and unconfirmed-stop diagnostics", async () => {
	for (const stopFails of [false, true]) {
		const f = fixture({ hold: "a", stopFails });
		const a = f.run("a"), b = f.run("b");
		const done = Promise.allSettled([a, b]);
		await until(() => f.operations.length === 1);
		f.ack(0, "cell-a"); await tick(); f.invoke("cell-a", 1, "a");
		await until(() => f.effects.length === 1);
		f.complete(0, "cell-a");
		await until(() => f.settling.has("a") && f.operations.length === 2);
		f.ack(1, "cell-b");
		f.operations[1].initial.resolve({ Result: { cell_id: "cell-b", content_items: [], error_text: "sibling failed" } });
		await until(() => Boolean(f.wire.failure));
		f.held.resolve();
		const results = await done;
		assert(results.every((result) => result.status === "rejected"));
		assert.equal(Boolean(f.bridges.get("a")!.unsettled), stopFails);
		assert.equal(Boolean(f.bridges.get("b")!.unsettled), stopFails);
		if (stopFails) assert(results.every((result) => result.status === "rejected" && /stop unconfirmed/.test(result.reason.message)));
	}
});

test("U4 protocol: success retires atomically after the last await; pre-start cancellation still checks shared stop", async () => {
	const f = fixture();
	const a = f.run("a");
	const bridge = f.bridges.get("a")!;
	const settled = bridge.settled.bind(bridge);
	let settlements = 0;
	bridge.settled = async () => {
		settlements++;
		if (settlements > 1) f.wire.fail(Error("unexpected extra retirement gap"));
		await settled();
	};
	await until(() => f.operations.length === 1);
	f.ack(0, "cell-a"); f.complete(0, "cell-a");
	assert.equal(await a, "completed"); assert.equal(settlements, 1);
	assert.equal(f.wire.failure, undefined);
	await f.runtime.close();

	const cancelled = new AbortController(); cancelled.abort();
	let g!: ReturnType<typeof fixture>;
	g = fixture({ stopFails: true, disarm: async () => { g.wire.fail(Error("shared failure while cancelling pre-start")); } });
	const empty = new ToolBridge([], [], "pre-start", ".", cancelled.signal, () => undefined, () => {}, () => {});
	await assert.rejects(g.runtime.run("text(1)", empty, cancelled.signal, 1000, () => {}, () => {}), /stop unconfirmed/);
	assert(empty.unsettled); assert.equal(g.operations.length, 0);
});

test("U4 bulk cancellation closes admission before removing another cell's FIFO barrier", async () => {
	for (const mode of ["session", "all", "failure", "close"]) {
		const scheduler = new Scheduler();
		const a = new AbortController(), b = new AbortController();
		const release = deferred<void>();
		let siblingEffects = 0;
		const tools = [{ name: "read", description: "read", parameters: Type.Object({}), effect: "read" as const, parallel: true,
			async invoke() { await release.promise; return { value: {} }; } },
		{ name: "write", description: "write", parameters: Type.Object({}), effect: "write" as const,
			async invoke() { return { value: {} }; } },
		{ name: "sibling", description: "sibling", parameters: Type.Object({}), effect: "read" as const, parallel: true,
			async invoke() { siblingEffects++; return { value: {} }; } }];
		const bridge = (signal: AbortSignal) => new ToolBridge(tools, [], "cell", ".", signal, () => undefined, () => {}, () => {}, { scheduler });
		const first = bridge(a.signal), second = bridge(b.signal);
		const done = Promise.allSettled([first.invoke("read", {}, "r", a.signal), first.invoke("write", {}, "w", a.signal),
			second.invoke("sibling", {}, "s", b.signal)]);
		await tick();
		if (mode === "session" || mode === "all") {
			const session = new CodeSession();
			Object.assign(session, { scheduler, cells: new Map([
				["a", { id: "a", cancel() { a.abort(); first.stop(); } }],
				["b", { id: "b", cancel() { b.abort(); second.stop(); } }],
			]) });
			if (mode === "all") session.terminateAll(); else session.cancel();
		} else {
			const f = fixture();
			Object.assign(f.runtime, { active: new Set([
				{ controller: a, bridge: first, rejectCell() {} }, { controller: b, bridge: second, rejectCell() {} },
			]) });
			if (mode === "failure") f.wire.fail(Error("fixture IPC failure")); else await f.runtime.close();
		}
		assert.equal(siblingEffects, 0, mode);
		release.resolve(); await done;
		assert.equal(siblingEffects, 0, mode);
	}
});

test("U4 shared scheduler: global four-worker limit and exclusive FIFO, normal bridge stop leaves siblings alive", async () => {
	const scheduler = new Scheduler();
	const release: (() => void)[] = [], entered: string[] = [];
	const make = (id: string, exclusive: boolean) => new ToolBridge([{
		name: id, description: id, effect: exclusive ? "write" : "read", parallel: !exclusive, parameters: Type.Object({}),
		async invoke() {
			entered.push(id);
			await new Promise<void>((resolve) => release.push(resolve));
			return { value: id };
		},
	}], [], id, ".", new AbortController().signal, () => undefined, () => {}, () => {}, { scheduler });
	const a = make("a", false), b = make("b", true), c = make("c", false);
	const calls = Array.from({ length: 4 }, (_, i) => a.invoke("a", {}, String(i), new AbortController().signal));
	const writer = b.invoke("b", {}, "w", new AbortController().signal);
	const after = c.invoke("c", {}, "r", new AbortController().signal);
	await tick(); assert.deepEqual(entered, ["a", "a", "a", "a"]);
	for (const end of release.slice(0, 3)) end();
	await tick(); assert.equal(entered.length, 4);
	release[3](); await Promise.all(calls); a.stop();
	await until(() => entered.length === 5); assert.equal(entered[4], "b");
	release[4](); await writer; b.stop();
	await until(() => entered.length === 6); assert.equal(entered[5], "c");
	release[5](); await after; c.stop();
	assert.equal(scheduler.peak, 4); assert.equal(a.peak, 4); assert.equal(b.peak, 1);
});

test("U4 limits: capacity validation and bounded wire observer expansion", async () => {
	const session = new CodeSession();
	assert.equal(session.maxCells, 1);
	for (const value of [0, 5, 1.5, NaN]) assert.throws(() => session.setMaxCells(value), /maxCells/);
	session.setMaxCells(4); assert.equal(session.maxCells, 4);
	const wire = Object.create(Wire.prototype) as Wire;
	Object.assign(wire, { observers: new Map(), onFailure() {} });
	const pending = Array.from({ length: 10 }, (_, id) => wire.expect("fixture", id, new AbortController().signal));
	assert.throws(() => wire.expect("fixture", 11, new AbortController().signal), /budget/);
	wire.fail(new Error("done"));
	assert((await Promise.allSettled(pending)).every((value) => value.status === "rejected"));
});
