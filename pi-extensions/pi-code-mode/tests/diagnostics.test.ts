import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import { Cell } from "../src/cell.ts";
import { ToolBridge } from "../src/bridge.ts";
import { Runtime } from "../src/runtime.ts";
import { LIMITS } from "../src/limits.ts";
import { collect } from "../src/catalog.ts";
import { registerCodeModeObserver, type CompletionReceipt } from "../src/contributions.ts";
import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { UnconfirmedRuntimeStop } from "../src/errors.ts";
import { CodeSession } from "../src/session.ts";
import { ReadRoot } from "../src/readonly.ts";
import { scratch } from "./helpers.ts";

test("output overflow preserves a Unicode prefix, cannot be made successful by a later terminate, and does not invent more output", async () => {
	const cell = new Cell(1000, async current => {
		current.append("界".repeat(12000));
		current.append("later");
		current.cancel("user terminate", true);
		return "terminated";
	});
	await cell.finished;
	const result = await cell.observe(0, 8192);
	assert(result.failed && result.truncated);
	assert.equal(result.errorKind, "output");
	assert.equal(result.text, "界".repeat(Math.floor(LIMITS.outputBytes / 3)));
	assert.equal(result.hasMoreOutput, false);
	assert(result.droppedBytes > 0);
	assert.equal((await cell.observe(0, 8192)).text, "");
});

test("overflow arriving after a user termination request is still a failure", async () => {
	const cell = new Cell(1000, async current => {
		current.cancel("user terminate", true);
		current.append("x".repeat(40000));
		return "terminated";
	});
	await cell.finished;
	const result = await cell.observe(0, 8192);
	assert(result.failed && result.truncated);
	assert.equal(result.errorKind, "output");
});

test("trace deltas are bounded, cancelled observations do not consume them; observer errors do not replace results", async () => {
	const receipts: CompletionReceipt[] = [];
	const cell = new Cell(1000, async current => {
		const bridge = new ToolBridge([{ name: "test", description: "fixture", effect: "read",
			parameters: Type.Object({}), invoke: async () => ({ value: { safe: true } }),
		}], [], current.id, ".", current.controller.signal, () => undefined, () => {}, () => {},
		{ origin: "outer", epoch: 7, observers: [
			{ id: "capture", complete: receipt => { receipts.push(receipt); assert(Object.isFrozen(receipt)); } },
			{ id: "broken", complete: () => { throw new Error("must not change result"); } },
		] });
		current.bridge = bridge;
		assert.deepEqual(await bridge.invoke("test", {}, "nested", current.controller.signal), { safe: true });
		return "completed";
	}, "outer");
	await cell.finished;
	await new Promise(resolve => setImmediate(resolve));
	const abort = AbortSignal.abort();
	await assert.rejects(cell.observe(0, 8192, abort));
	const first = await cell.observe(0, 8192);
	assert.equal(first.traces.length, 1);
	assert.equal(first.traces[0].state, "completed");
	assert(first.traces[0].settledAt! >= first.traces[0].startedAt!);
	assert.equal(first.observerFailures, 1);
	assert.equal(first.originToolCallId, "outer");
	assert.equal((await cell.observe(0, 8192)).traces.length, 0);
	assert.equal(receipts[0].epoch, 7);
	assert(!("input" in receipts[0]) && !("value" in receipts[0]));
});

test("observer discovery is explicit, bounded, duplicate-safe and disposable", () => {
	const pi = { events: createEventBus() } as unknown as ExtensionAPI;
	const stop = registerCodeModeObserver(pi, { id: "diagnostic", complete() {} });
	assert.equal(collect(pi).observers?.length, 1);
	const duplicate = registerCodeModeObserver(pi, { id: "diagnostic", complete() {} });
	assert.throws(() => collect(pi), /duplicate Code Mode observer/);
	duplicate(); stop();
	assert.equal(collect(pi).observers?.length, 0);
});

test("escaped trace identities cannot exceed the metadata page budget", async () => {
	const name = "n".repeat(82);
	const cell = new Cell(1000, async current => {
		current.bridge = new ToolBridge([{ name, description: "fixture", effect: "read",
			parameters: Type.Object({}), invoke: async () => ({ value: 1 }),
		}], [], current.id, ".", current.controller.signal, () => undefined, () => {}, () => {});
		for (let i = 0; i < 32; i++) await current.bridge.invoke(name, {}, "\0".repeat(125) + i, current.controller.signal);
		return "completed";
	});
	await cell.finished;
	let result = await cell.observe(0, 8192);
	const ids = new Set(result.traces.map(t => t.id));
	assert(result.hasMoreTraces);
	assert(Buffer.byteLength(JSON.stringify(result.traces)) <= LIMITS.traceBytes);
	while (result.hasMoreTraces) {
		result = await cell.observe(0, 8192);
		assert(Buffer.byteLength(JSON.stringify(result.traces)) <= LIMITS.traceBytes);
		for (const trace of result.traces) { assert(!ids.has(trace.id)); ids.add(trace.id); }
	}
	assert.equal(ids.size, 32);
});

test("a failed Host stop becomes unconfirmed effects, not a successful user cancellation", async () => {
	const runtime = Object.create(Runtime.prototype) as Runtime;
	Object.assign(runtime, {
		active: new Set(), cells: new Map(), starts: Promise.resolve(), delegates: new Map(), delegateIds: new Set(),
		supervisor: { arm: async () => async () => {}, stop: async () => { throw new Error("cannot prove stop"); } },
		wire: {
			start: () => ({ started: Promise.resolve({ type: "execution/started", cellId: "backend" }),
				initial: Promise.resolve({ Result: { cell_id: "backend", content_items: [{ type: "image" }] } }) }),
			fail() {},
		},
	});
	const signal = new AbortController().signal;
	const bridge = new ToolBridge([], [], "fixture", ".", signal, () => undefined, () => {}, () => {});
	await assert.rejects(runtime.run("text(1)", bridge, signal, 1000, () => {}, () => {}), /stop unconfirmed/);
	assert.match(bridge.unsettled?.message ?? "", /cannot prove stop/);
});

test("unconfirmed startup stop poisons the session even before a bridge/runtime is assigned", async (t) => {
	const original = Runtime.create;
	Runtime.create = async () => { throw new UnconfirmedRuntimeStop("startup fixture"); };
	t.after(() => { Runtime.create = original; });
	const session = new CodeSession();
	await session.authorize(await scratch("startup-unconfirmed"), "/fixture");
	const root = (session as unknown as { root: ReadRoot }).root;
	try {
		const result = await session.execute("text(1)", undefined, { yield_time_ms: 5000 });
		assert(result.failed && result.effectsUnsettled && result.runtimeReset);
		assert(session.blocked);
		await assert.rejects(session.execute("text(2)"), /blocked/);
		await assert.rejects(session.revoke(true), /Unconfirmed/);
	} finally { await root.close(); }
});
