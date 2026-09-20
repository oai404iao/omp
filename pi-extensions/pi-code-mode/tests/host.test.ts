import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CodeSession } from "../src/session.ts";
import { LIMITS } from "../src/limits.ts";
import { scratch } from "./helpers.ts";
import { prepareHost } from "../src/asset.ts";
import { Supervisor, control } from "../src/supervisor.ts";
import { Wire, object } from "../src/wire.ts";

const source = process.env.CODE_MODE_TEST_HOST;
assert(source, "CODE_MODE_TEST_HOST must name the pinned executable; Host tests never silently skip");
const state = await scratch("host-state");
process.env.XDG_STATE_HOME = state;

test("real S1 runtime: enforced Host, local reads, store, errors, cancellation and invalidation", { timeout: 90000 }, async (t) => {
	const cwd = await scratch("host-cwd");
	await writeFile(join(cwd, "a.txt"), "alpha");
	await writeFile(join(cwd, "b.txt"), "beta");
	const session = new CodeSession();
	t.after(() => session.revoke(true));
	await session.authorize(cwd, source);
	const first = await session.execute("const rs=await Promise.all(['a.txt','b.txt'].map(path=>tools.read({path}))); store('sum',rs.map(r=>r.text).join(',')); text(load('sum'))");
	assert.equal(first.text, "alpha,beta");
	assert.equal(first.calls, 2);
	assert.equal(first.fresh, true);
	assert(first.peak <= 4);
	const second = await session.execute("text(load('sum')); text(typeof rs)");
	assert.equal(second.text, "alpha,beta\nundefined");
	assert.equal(second.fresh, false);
	assert.equal(second.epoch, first.epoch);
	const denied = await session.execute("try { await tools.read({path:'../nope'}) } catch(e) {text(String(e))}");
	assert.match(denied.text, /outside/);
	assert.match((await session.execute("text('x'.repeat(40000))")).error ?? "", /output budget/);
	assert.equal((await session.execute("text(typeof load('sum'))")).text, "undefined");
	await session.execute("store('x',1)");
	await session.invalidate();
	assert.equal((await session.execute("text(typeof load('x'))")).text, "undefined");
	const abort = new AbortController();
	const infinite = session.execute("while(true){}", abort.signal, { yield_time_ms: 3000 });
	await assert.rejects(session.execute("text('concurrent')"), /Only one/);
	setTimeout(() => abort.abort(new Error("test abort")), 300);
	await assert.rejects(infinite, /cancel|abort|closed|timed out/i);
	const running = session.activeCell!;
	await session.wait(running.id, { terminate: true, yield_time_ms: 5000 });
	assert.equal((await session.execute("text(42)")).text, "42");
	const flood = await session.execute("await Promise.all(Array.from({length:100},()=>tools.read({path:'a.txt'})))", undefined, { yield_time_ms: 5000 });
	assert(flood.failed);
	await session.revoke();
	await assert.rejects(session.execute("text(1)"), /explicit/);
});

test("real S1 runtime: bounded allocation hits cgroup memory limit, not the Pi process", { timeout: 20000 }, async (t) => {
	const session = new CodeSession();
	t.after(() => session.revoke(true));
	await session.authorize(await scratch("memory"), source);
	const failed = await session.execute("const held=[]; for(let i=0;i<32;i++)held.push(new Array(4000000).fill(i)); text('unexpected')", undefined, { yield_time_ms: 5000 });
	assert(failed.failed);
	assert.equal((await session.execute("text('alive')")).text, "alive");
});

test("real S1 runtime: parent execution deadline is finite", { timeout: 45000 }, async (t) => {
	const session = new CodeSession();
	t.after(() => session.revoke(true));
	await session.authorize(await scratch("deadline"), source);
	const started = Date.now();
	const failed = await session.execute("while(true){}", undefined, { timeout_ms: 1000, yield_time_ms: 5000 });
	assert(failed.failed);
	assert(Date.now() - started < LIMITS.watchdogSeconds * 1000 + 5000);
});

async function rawHost(t: import("node:test").TestContext) {
	const asset = await prepareHost(source!);
	const supervisor = new Supervisor(asset.binary, asset.directory);
	const wire = new Wire(supervisor.child);
	t.after(async () => { wire.fail(new Error("test done")); await supervisor.stop(); });
	const signal = AbortSignal.timeout(50000);
	const ready = wire.expect("connection/ready", 0, signal);
	await wire.send({ type: "connection/hello", supportedVersions: [1], requiredCapabilities: [], optionalCapabilities: [] });
	assert.equal(object(await ready).selectedVersion, 1);
	await supervisor.verify(signal);
	await supervisor.arm(signal, 2);
	await wire.request({ method: "session/open", sessionId: "proof" }, signal);
	return { supervisor, wire, signal };
}

test("real supervisor: independent per-exec timer kills Host without a parent execution timeout", { timeout: 50000 }, async (t) => {
	const { supervisor, wire, signal } = await rawHost(t);
	const startedAt = Date.now();
	const operation = wire.start({ method: "session/execute", sessionId: "proof", request: {
		tool_call_id: "watchdog", enabled_tools: [], source: "while(true){}", yield_time_ms: 10, max_output_tokens: 100,
	} }, signal);
	await operation.started;
	assert("Yielded" in object(await operation.initial));
	await supervisor.exited; // no Runtime.execute() parent timeout in this probe
	assert.equal(await control("/usr/bin/systemctl", ["--user", "show", supervisor.unit, "--property=Result", "--value"]), "signal");
	assert(Date.now() - startedAt >= 1000 && Date.now() - startedAt < 8000);
});

test("real supervisor: bounded allocation produces an explicit kernel OOM outcome", { timeout: 15000 }, async (t) => {
	const { supervisor, wire, signal } = await rawHost(t);
	const operation = wire.start({ method: "session/execute", sessionId: "proof", request: {
		tool_call_id: "oom", enabled_tools: [], source: "const held=[]; for(let i=0;i<32;i++)held.push(new Array(4000000).fill(i))",
		yield_time_ms: 10, max_output_tokens: 100,
	} }, signal);
	await Promise.all([operation.started, operation.initial]).catch(() => {});
	await supervisor.exited;
	assert.equal(await control("/usr/bin/systemctl", ["--user", "show", supervisor.unit, "--property=Result", "--value"]), "oom-kill");
});
