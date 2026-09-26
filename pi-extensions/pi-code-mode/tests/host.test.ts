import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile, symlink, open, chmod, stat, rename } from "node:fs/promises";
import { join } from "node:path";
import { CodeSession } from "../src/session.ts";
import { LIMITS, HOST } from "../src/limits.ts";
import { scratch } from "./helpers.ts";
import { prepareHost } from "../src/asset.ts";
import { Supervisor, control } from "../src/supervisor.ts";
import { Wire, object } from "../src/wire.ts";
import { createEventBus, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { doctor } from "../src/doctor.ts";
import { Runtime } from "../src/runtime.ts";
import { UnconfirmedRuntimeStop } from "../src/errors.ts";

const source = process.env.CODE_MODE_TEST_HOST;
assert(source, "CODE_MODE_TEST_HOST must name the pinned executable; Host tests never silently skip");
const state = await scratch("host-state");
process.env.XDG_STATE_HOME = state;

test("U0 asset identity: reject symlink, old size and same-size tampering before execution", async () => {
	const dir = await scratch("u0-assets");
	const link = join(dir, "link");
	await symlink(source!, link);
	await assert.rejects(prepareHost(link), /ELOOP/);
	const fake = join(dir, "fake");
	const file = await open(fake, "wx", 0o600);
	try {
		await file.truncate(46_139_288);
		await assert.rejects(prepareHost(fake), /pinned/);
		await file.truncate(HOST.bytes);
		await assert.rejects(prepareHost(fake), /SHA-256 mismatch/);
	} finally { await file.close(); }
});

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
	assert.equal((await session.execute("text(load('sum'))")).text, "alpha,beta", "bounded output failure can preserve a confirmed runtime");
	await session.execute("store('x',1)");
	await session.invalidate();
	assert.equal((await session.execute("text(typeof load('x'))")).text, "undefined");
	const abort = new AbortController();
	const infinite = session.execute("while(true){}", abort.signal, { yield_time_ms: 3000 });
	await assert.rejects(session.execute("text('concurrent')"), /capacity 1/);
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

test("official Host: empty args, undefined store, negotiated durations and ordinary sorting", { timeout: 15000 }, async (t) => {
	const session = new CodeSession();
	t.after(() => session.revoke(true));
	await session.authorize(await scratch("u0-host"), source);
	const result = await session.execute(`
		text((await tools.ls()).entries.length);
		text((await tools.ls(undefined)).entries.length);
		text((await tools.ls(null)).entries.length);
		store("keep", 7); try { store("keep", undefined); } catch { text("rejected"); }
		text(load("keep")); text([3,1,2].sort((a,b)=>a-b));
	`, undefined, { yield_time_ms: 5000 });
	assert.equal(result.failed, false, result.error ?? "Host execution should succeed");
	assert.equal(result.text, "0\n0\n0\nrejected\n7\n[1,2,3]");
	assert(result.hostDurationNs > 0 && Number.isSafeInteger(result.hostDurationNs));
});

test("U1 doctor host is explicit pure computation; helper globals keep their documented cell semantics", { timeout: 15000 }, async (t) => {
	const cwd = await scratch("u1-host");
	const pi = { events: createEventBus(), getFlag: (name: string) => name === "code-mode-host" ? source : undefined } as unknown as ExtensionAPI;
	assert.match(await doctor(pi, { cwd } as ExtensionContext, true), /supervised pure-computation Host probe: OK/);
	const session = new CodeSession();
	t.after(() => session.revoke(true));
	await session.authorize(cwd, source);
	const result = await session.execute(`
		text(ALL_TOOLS.map(t=>t.name).sort());
		text("before"); yield_control();
		await new Promise(resolve=>setTimeout(resolve,100));
		store("exit",1); text("after"); exit(); text("unreachable");
	`, undefined, { yield_time_ms: 5000 });
	assert.equal(result.text, '["ls","read"]\nbefore\nafter');
	assert.equal(result.failed, false);
	assert.equal((await session.execute('text(load("exit"))')).text, "1");
});

test("U1 doctor: cancellation/stale context during startup still closes its separate Host", { timeout: 15000 }, async (t) => {
	const original = Runtime.create;
	let runtime: Runtime | undefined;
	const controller = new AbortController();
	let stale = false;
	Runtime.create = async (path, signal) => {
		runtime = await original(path, signal);
		stale = true;
		controller.abort(new Error("simulated shutdown during startup"));
		return runtime;
	};
	t.after(() => { Runtime.create = original; });
	const cwd = await scratch("doctor-cancel");
	const ctx = { get cwd() { if (stale) throw new Error("stale context"); return cwd; } } as ExtensionContext;
	const pi = { events: createEventBus(), getFlag: (name: string) => name === "code-mode-host" ? source : undefined } as unknown as ExtensionAPI;
	const report = await doctor(pi, ctx, true, controller.signal);
	assert.match(report, /Host probe: FAILED/);
	assert(runtime?.failed, "probe cleanup must close the started Host");
});

test("U2 verified cache: concurrent publication, per-launch recheck and symlink rejection", async (t) => {
	const previous = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = await scratch("u2-cache");
	t.after(() => { process.env.XDG_STATE_HOME = previous; });
	const assets = await Promise.all([1, 2, 3].map(() => prepareHost(source!)));
	assert.equal(new Set(assets.map(a => a.binary)).size, 1);
	assert.equal(new Set(assets.map(a => a.directory)).size, 3);
	const binary = assets[0].binary;
	assert.equal((await stat(binary)).nlink, 1);
	await chmod(binary, 0o700);
	const file = await open(binary, "r+");
	try { await file.write(Buffer.from([0]), 0, 1, 0); } finally { await file.close(); }
	await chmod(binary, 0o500);
	await assert.rejects(prepareHost(source!), /SHA-256 mismatch/);
	const cache = join(process.env.XDG_STATE_HOME!, "pi-code-mode/hosts");
	await rename(cache, `${cache}-retained`);
	await symlink(`${cache}-retained`, cache);
	await assert.rejects(prepareHost(source!), /not a symlink/);
});

test("U2 overflow: retain bounded prefix and earlier store; distinguish completion commits from terminated pending writes", { timeout: 20000 }, async (t) => {
	const session = new CodeSession();
	t.after(() => session.revoke(true));
	await session.authorize(await scratch("u2-overflow"), source);
	await session.execute('store("old",1)');
	const failed = await session.execute('store("pending",2);text("界".repeat(12000));await new Promise(()=>{})', undefined, { yield_time_ms: 5000 });
	assert(failed.failed && failed.truncated);
	assert.equal(failed.errorKind, "output");
	assert.equal(failed.runtimeReset, false);
	assert.equal(failed.hostCompleted, false);
	assert.equal(failed.hasMoreOutput, false);
	assert(!failed.text.includes("\ufffd"));
	assert.equal((await session.execute('text([load("old"),typeof load("pending")])')).text, '[1,"undefined"]');
	const completed = await session.execute('store("committed",3);text("x".repeat(40000))', undefined, { yield_time_ms: 5000 });
	assert(completed.failed && completed.hostCompleted && !completed.runtimeReset);
	assert.equal((await session.execute('text(load("committed"))')).text, "3");
	const script = await session.execute('text("partial");throw new Error("script failure")', undefined, { yield_time_ms: 5000 });
	assert(script.failed && script.runtimeReset);
	assert.equal(script.errorKind, "script");
	assert.equal(script.text, "partial");
	assert.equal((await session.execute('text(typeof load("old"))')).text, "undefined");
});

test("U2 startup failure propagates an unconfirmed-stop marker; fixture cleanup still stops its real Host", { timeout: 15000 }, async () => {
	const verify = Supervisor.prototype.verify;
	const stop = Supervisor.prototype.stop;
	let supervisor: Supervisor | undefined;
	Supervisor.prototype.verify = async function () { supervisor = this; throw new Error("fixture verification failed"); };
	Supervisor.prototype.stop = async () => { throw new Error("fixture stop unconfirmed"); };
	try {
		await assert.rejects(Runtime.create(source!, AbortSignal.timeout(5000)), UnconfirmedRuntimeStop);
	} finally {
		Supervisor.prototype.verify = verify;
		Supervisor.prototype.stop = stop;
		await supervisor?.stop();
	}
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
