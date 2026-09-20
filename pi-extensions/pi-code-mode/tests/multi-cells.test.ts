import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { CodeSession } from "../src/session.ts";
import { Runtime } from "../src/runtime.ts";
import type { Catalog } from "../src/catalog.ts";
import type { Observation } from "../src/cell.ts";
import { scratch } from "./helpers.ts";

const host = process.env.CODE_MODE_TEST_HOST;
assert(host, "CODE_MODE_TEST_HOST required");
process.env.XDG_STATE_HOME = await scratch("multi-state");
const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
async function until(predicate: () => boolean) {
	for (let i = 0; i < 500 && !predicate(); i++) await delay(10);
	assert(predicate(), "Multi-cell lifecycle milestone not reached");
}
async function setup(t: TestContext, max = 2) {
	const session = new CodeSession(); session.setMaxCells(max);
	t.after(() => session.revoke(true));
	await session.authorize(await scratch("multi-root"), host!, { write: false, process: false, tools: ["fixture__hold", "fixture__write"] });
	const gates = new Map<string, () => void>();
	let effects = 0;
	const catalog: Catalog = { policies: [], tools: [{
		name: "fixture__hold", description: "test barrier", effect: "read", parallel: true,
		parameters: Type.Object({ key: Type.String() }),
		async invoke(input, ctx) {
			const key = (input as { key: string }).key;
			await new Promise<void>((resolve, reject) => {
				const done = () => { ctx.signal.removeEventListener("abort", abort); resolve(); };
				const abort = () => { ctx.signal.removeEventListener("abort", abort); reject(ctx.signal.reason); };
				gates.set(key, done); ctx.signal.addEventListener("abort", abort, { once: true });
				if (ctx.signal.aborted) abort();
			});
			return { value: key, usage };
		},
	}, { name: "fixture__write", description: "exclusive fixture", parameters: Type.Object({}), effect: "write",
		async invoke() { effects++; return { value: effects }; } }] };
	return { session, catalog, gates, effects: () => effects };
}
async function finish(session: CodeSession, first: Observation): Promise<Observation> {
	let value = first;
	while (!["completed", "terminated", "failed"].includes(value.state)) value = await session.wait(value.cellId, { yield_time_ms: 5000 });
	return value;
}

test("U4 concurrent admission initializes ONE shared Host, isolates origins/usage/results and enforces four slots", { timeout: 20000 }, async (t) => {
	const f = await setup(t, 4);
	const create = Runtime.create;
	let starts = 0;
	Runtime.create = async (...args) => { starts++; return create(...args); };
	t.after(() => { Runtime.create = create; });
	const cells = await Promise.all(Array.from({ length: 4 }, (_, i) => f.session.execute(
		`text(await tools.fixture__hold({key:"${i}"})); store("key${i}",${i})`, undefined, { yield_time_ms: 0 }, f.catalog, `origin${i}`)));
	await assert.rejects(f.session.execute("text(5)"), /capacity 4/);
	await until(() => f.gates.size === 4);
	assert.equal(starts, 1);
	for (const gate of f.gates.values()) gate();
	const results = await Promise.all(cells.map((cell) => finish(f.session, cell)));
	assert.deepEqual(results.map((value) => value.text), ["0", "1", "2", "3"]);
	assert(results.every((value) => value.state === "completed" && value.epoch === 1 && value.usage?.totalTokens === 3));
	assert.deepEqual(results.map((value) => value.originToolCallId), ["origin0", "origin1", "origin2", "origin3"]);
	assert.equal(f.session.cellList.length, 0);
	assert.equal((await f.session.execute('text([0,1,2,3].map(i=>load("key"+i)))')).text, "[0,1,2,3]");
	for (const cell of cells) await assert.rejects(f.session.wait(cell.cellId), /stale/);
});

test("U4 shared store uses snapshots and actual commit order, merging only written keys", { timeout: 15000 }, async (t) => {
	const f = await setup(t);
	await f.session.execute('store("x","seed")');
	const a = await f.session.execute('text(load("x")); await tools.fixture__hold({key:"a"}); store("x","A"); store("a",1)',
		undefined, { yield_time_ms: 0 }, f.catalog);
	await until(() => f.gates.has("a"));
	const b = await f.session.execute('text(load("x")); store("x","B"); store("b",2)');
	assert.equal(b.text, "seed");
	f.gates.get("a")!();
	assert.equal((await finish(f.session, a)).text, "seed");
	const last = await f.session.execute('text([load("x"),load("a"),load("b")])');
	assert.equal(last.text, '["A",1,2]');
});

test("U4 cancellation removes only its queued writer; sibling reads/store survive on the same Host", { timeout: 15000 }, async (t) => {
	const f = await setup(t, 3);
	await f.session.execute('store("prior",7)');
	const a = await f.session.execute('await Promise.all([0,1,2,3].map(i=>tools.fixture__hold({key:"r"+i}))); text(load("prior"))',
		undefined, { yield_time_ms: 0 }, f.catalog);
	await until(() => f.gates.size === 4);
	const b = await f.session.execute('await tools.fixture__write({}); text("should-not-run")', undefined, { yield_time_ms: 0 }, f.catalog);
	await until(() => {
		const cells = (f.session as unknown as { cells: Map<string, { bridge?: { calls: number } }> }).cells;
		return cells.get(b.cellId)?.bridge?.calls === 1;
	});
	const c = await f.session.execute('text(await tools.fixture__hold({key:"later"}))', undefined, { yield_time_ms: 0 }, f.catalog);
	const stopped = await f.session.wait(b.cellId, { terminate: true, yield_time_ms: 5000 });
	assert.equal(stopped.state, "terminated"); assert.equal(f.effects(), 0);
	f.gates.get("r0")!();
	await until(() => f.gates.has("later"));
	f.gates.get("later")!();
	assert.equal((await finish(f.session, c)).text, "later");
	for (const [key, gate] of f.gates) if (key.startsWith("r")) gate();
	const result = await finish(f.session, a);
	assert.equal(result.text, "7"); assert.equal(result.runtimeReset, false);
	assert.equal((await f.session.execute('text(load("prior"))')).text, "7");
});

test("U4 unread terminal output occupies slots; independent observations release only their own slot", { timeout: 15000 }, async (t) => {
	const f = await setup(t);
	const a = await f.session.execute('text("abcdefghij")', undefined, { max_tokens: 1, yield_time_ms: 5000 });
	const b = await f.session.execute('text("klmnopqrst")', undefined, { max_tokens: 1, yield_time_ms: 5000 });
	assert(a.hasMoreOutput && b.hasMoreOutput); assert.equal(f.session.cellList.length, 2);
	await assert.rejects(f.session.execute("text(3)"), (error: Error) => error.message.includes(a.cellId) && error.message.includes(b.cellId));
	assert.equal((await f.session.wait(a.cellId)).text, "efghij");
	assert.equal((await f.session.execute("text(3)")).text, "3");
	assert.equal((await f.session.wait(b.cellId)).text, "opqrst");
	assert.equal(f.session.cellList.length, 0);
});

test("U4 cancelling during shared initialization does not cancel the sibling or initialize twice", { timeout: 15000 }, async (t) => {
	const f = await setup(t);
	const a = await f.session.execute('await new Promise(()=>{})', undefined, { yield_time_ms: 0 });
	const b = await f.session.execute('text("survivor")', undefined, { yield_time_ms: 0 });
	f.session.terminate(a.cellId);
	const results = await Promise.all([finish(f.session, a), finish(f.session, b)]);
	assert.equal(results[0].state, "terminated");
	assert.equal(results[1].state, "completed"); assert.equal(results[1].text, "survivor");
	assert.equal(results[1].runtimeReset, false);
});

test("U4 script failure collateral-fails sibling cells and loses shared store, then starts a fresh epoch", { timeout: 15000 }, async (t) => {
	const f = await setup(t);
	await f.session.execute('store("prior",7)');
	const a = await f.session.execute('await tools.fixture__hold({key:"a"}); text("not reached")', undefined, { yield_time_ms: 0 }, f.catalog);
	await until(() => f.gates.has("a"));
	const b = await f.session.execute('throw Error("shared failure")', undefined, { yield_time_ms: 5000 });
	const sibling = await finish(f.session, a);
	assert.equal(b.state, "failed"); assert.equal(b.runtimeReset, true);
	assert.equal(sibling.state, "failed"); assert.equal(sibling.runtimeReset, true);
	assert.equal(sibling.text, "");
	const fresh = await f.session.execute('text(typeof load("prior"))', undefined, { yield_time_ms: 5000 });
	assert.equal(fresh.text, "undefined"); assert.equal(fresh.epoch, 2); assert(fresh.fresh);
});

test("U4 actual OS watchdog kills the shared Host, invalidating every cell", { timeout: 15000 }, async (t) => {
	const f = await setup(t);
	await f.session.execute('store("prior",7)');
	const runtime = (f.session as unknown as { runtime: { supervisor: { arm: (signal: AbortSignal, seconds?: number) => Promise<() => Promise<void>> } } }).runtime;
	const arm = runtime.supervisor.arm.bind(runtime.supervisor);
	runtime.supervisor.arm = (signal) => arm(signal, 1);
	const a = await f.session.execute('await new Promise(()=>{})', undefined, { yield_time_ms: 0 });
	const b = await f.session.execute('await new Promise(()=>{})', undefined, { yield_time_ms: 0 });
	const results = await Promise.all([finish(f.session, a), finish(f.session, b)]);
	assert(results.every((value) => value.state === "failed" && value.runtimeReset && !value.effectsUnsettled));
	assert.equal((await f.session.execute('text(typeof load("prior"))', undefined, { yield_time_ms: 5000 })).text, "undefined");
});

test("U4 invalidation revokes all cell IDs; normal single termination remains precise", { timeout: 15000 }, async (t) => {
	const f = await setup(t);
	const a = await f.session.execute('await new Promise(()=>{})', undefined, { yield_time_ms: 0 });
	const b = await f.session.execute('await new Promise(()=>{})', undefined, { yield_time_ms: 0 });
	await f.session.invalidate();
	for (const cell of [a, b]) await assert.rejects(f.session.wait(cell.cellId), /stale/);
	assert.equal(f.session.cellList.length, 0);
	assert.equal((await f.session.execute("text(1)", undefined, { yield_time_ms: 5000 })).text, "1");
});
