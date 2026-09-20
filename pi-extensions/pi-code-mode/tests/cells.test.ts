import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { CodeSession } from "../src/session.ts";
import { scratch } from "./helpers.ts";

const host = process.env.CODE_MODE_TEST_HOST;
assert(host, "CODE_MODE_TEST_HOST required");
process.env.XDG_STATE_HOME = await scratch("s2-cell-state");

test("S2 cells: yield, single observer, observation abort, terminal consumption and stale IDs", { timeout: 15000 }, async (t) => {
	const session = new CodeSession(); t.after(() => session.revoke(true));
	await session.authorize(await scratch("s2-observe"), host);
	const first = await session.execute("await new Promise(r=>setTimeout(r,1000)); text('done')", undefined, { yield_time_ms: 0 });
	assert.equal(first.state, "running");
	await assert.rejects(session.execute("text('duplicate')"), /Only one/);
	const controller = new AbortController();
	const pending = session.wait(first.cellId, { yield_time_ms: 3000 }, controller.signal);
	await assert.rejects(session.wait(first.cellId), /observer/);
	controller.abort();
	await assert.rejects(pending);
	const done = await session.wait(first.cellId, { yield_time_ms: 5000 });
	assert.equal(done.state, "completed"); assert.equal(done.text, "done");
	await assert.rejects(session.wait(first.cellId), /consumed or stale/);
});

test("S2 terminate: preserve earlier store, discard pending writes, never replay consumed cells", { timeout: 15000 }, async (t) => {
	const session = new CodeSession(); t.after(() => session.revoke(true));
	await session.authorize(await scratch("s2-terminate"), host);
	await session.execute("store('prior',42)");
	const first = await session.execute("store('pending',1); text('started'); await new Promise(()=>{})");
	assert.equal(first.state, "running"); assert.equal(first.text, "started");
	const terminating = await session.wait(first.cellId, { terminate: true, yield_time_ms: 0 });
	assert.equal(terminating.state, "terminating");
	const done = await session.wait(first.cellId, { yield_time_ms: 5000 });
	assert.equal(done.state, "terminated"); assert.equal(done.failed, false);
	assert.equal((await session.execute("text(load('prior')); text(typeof load('pending'))")).text, "42\nundefined");
	await session.invalidate();
	await assert.rejects(session.wait(first.cellId), /stale/);
	assert.equal((await session.execute("text(typeof load('prior'))")).text, "undefined");
});

test("S2 writes: opt-in, atomic replacement, queue cooperation, escape/link rejection and limits", { timeout: 15000 }, async (t) => {
	const parent = await scratch("s2-write");
	const cwd = join(parent, "project"); await mkdir(cwd);
	const session = new CodeSession(); t.after(() => session.revoke(true));
	await session.authorize(cwd, host);
	assert.equal((await session.execute("text(typeof tools.write); text(typeof tools.bash)")).text, "undefined\nundefined");
	await session.revoke();
	await session.authorize(cwd, host, { write: true, process: false, tools: [] });
	const output = await session.execute("await tools.write({path:'a.txt',content:'first'}); await tools.write({path:'a.txt',content:'second'}); text((await tools.read({path:'a.txt'})).text)");
	assert.equal(output.text, "second");
	assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), "second");
	assert.equal((await session.execute("text((await tools.write({path:'big',content:'a'.repeat(131072)})).bytesWritten)")).text, "131072");
	const escaped = await session.execute("await tools.write({path:'../outside',content:'bad'})");
	assert(escaped.failed); await assert.rejects(readFile(join(parent, "outside")));
	await writeFile(join(parent, "outside"), "unchanged");
	await symlink(join(parent, "outside"), join(cwd, "link"));
	assert((await session.execute("await tools.write({path:'link',content:'bad'})")).failed);
	assert.equal(await readFile(join(parent, "outside"), "utf8"), "unchanged");
	assert((await session.execute("await tools.write({path:'big',content:'a'.repeat(131073)})")).failed);
});

test("S2 process: explicit grant, supervised commands, real exit codes, bounds and termination", { timeout: 30000 }, async (t) => {
	const cwd = await scratch("s2-process");
	const session = new CodeSession(); t.after(() => session.revoke(true));
	await session.authorize(cwd, host, { write: false, process: true, tools: [] });
	const success = await session.execute("text(await tools.bash({command:'printf hello; printf warning >&2; exit 7'}))", undefined, { yield_time_ms: 10000 });
	assert.equal(success.state, "completed", success.error ?? "");
	assert.deepEqual(JSON.parse(success.text), { stdout: "hello", stderr: "warning", exitCode: 7 });
	const timeout = await session.execute("await tools.bash({command:'sleep 10',timeout_ms:100})", undefined, { yield_time_ms: 5000 });
	assert(timeout.failed);
	const flood = await session.execute("await tools.bash({command:\"printf '%100000s' x\"})", undefined, { yield_time_ms: 5000 });
	assert(flood.failed);
	const running = await session.execute("text('starting'); await tools.bash({command:\"trap '' TERM; sleep 20\",timeout_ms:25000})");
	assert.equal(running.state, "running");
	const requested = await session.wait(running.cellId, { terminate: true, yield_time_ms: 0 });
	assert.equal(requested.state, "terminating");
	const stopped = await session.wait(running.cellId, { yield_time_ms: 10000 });
	assert.equal(stopped.state, "terminated", stopped.error ?? "");
	assert.equal(stopped.effectsUnsettled, false);
});

test("S2 cell total deadline is not extended by repeated wait observations", { timeout: 10000 }, async (t) => {
	const session = new CodeSession(); t.after(() => session.revoke(true));
	await session.authorize(await scratch("s2-deadline"), host);
	const start = Date.now();
	let result = await session.execute("while(true){}", undefined, { yield_time_ms: 0, timeout_ms: 1500 });
	while (!["terminated", "failed", "completed"].includes(result.state)) result = await session.wait(result.cellId, { yield_time_ms: 250 });
	assert.equal(result.state, "terminated");
	assert(result.failed);
	assert(Date.now() - start < 6000);
});

test("S2 cancelled initial observer: busy exec returns a recoverable cell handle", { timeout: 10000 }, async (t) => {
	const session = new CodeSession(); t.after(() => session.revoke(true));
	await session.authorize(await scratch("s2-recover"), host);
	const controller = new AbortController();
	const initial = session.execute("await new Promise(()=>{})", controller.signal, { yield_time_ms: 10000 });
	controller.abort();
	await assert.rejects(initial);
	const id = session.activeCell!.id;
	await assert.rejects(session.execute("text('next')"), (error: Error) => error.message.includes(id));
	assert.equal((await session.wait(id, { terminate: true, yield_time_ms: 5000 })).state, "terminated");
});
