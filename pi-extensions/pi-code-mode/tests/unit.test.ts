import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile, mkdir, symlink, rename } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { ReadRoot } from "../src/readonly.ts";
import { ToolBridge } from "../src/bridge.ts";
import { Type } from "typebox";
import { Wire } from "../src/wire.ts";
import { LIMITS } from "../src/limits.ts";
import { prepareHost, verifyPlatform } from "../src/asset.ts";
import { CodeSession } from "../src/session.ts";
import { Supervisor } from "../src/supervisor.ts";
import { scratch } from "./helpers.ts";

const signal = () => new AbortController().signal;
function readBridge(root: ReadRoot, currentSignal: AbortSignal) {
	let id = 0;
	const bridge = new ToolBridge([{
		name: "read", description: "fixture", effect: "read", parallel: true, parameters: Type.Object({}),
		invoke: async (args, ctx) => ({ value: (await root.invoke("read", args, ctx.signal) ?? null) as never }),
	}], [], "fixture", ".", currentSignal, () => undefined, () => {}, () => {});
	return {
		invoke: (name: string, args: unknown, callSignal = currentSignal) => bridge.invoke(name, args, String(++id), callSignal),
		stop: () => bridge.stop(), settled: () => bridge.settled(),
		get peak() { return bridge.peak; },
	};
}

test("read root: bounded bytes, listings, path escape, symlinks and special files", async () => {
	const dir = await scratch("reads");
	const rootPath = join(dir, "root");
	await mkdir(rootPath);
	await writeFile(join(rootPath, "file"), "abcdef");
	await writeFile(join(dir, "outside"), "outside");
	await symlink(join(dir, "outside"), join(rootPath, "link"));
	await symlink(rootPath, join(rootPath, "inside-link"));
	const root = await ReadRoot.grant(rootPath);
	try {
		assert.deepEqual(await root.invoke("read", { path: "file", offset: 2, limit: 2 }, signal()),
			{ text: "cd", nextOffset: 4, truncated: true });
		assert.deepEqual(await root.invoke("read", { path: "file", offset: 4 }, signal()),
			{ text: "ef", nextOffset: 6, truncated: false });
		for (const path of ["../outside", join(dir, "outside"), "link", "inside-link/file", "file\0"]) {
			await assert.rejects(root.invoke("read", { path }, signal()));
		}
		await assert.rejects(root.invoke("read", { path: "file", limit: LIMITS.readBytes + 1 }, signal()), /invalid/);
		await assert.rejects(root.invoke("bash", { command: "echo unsafe" }, signal()), /Unknown/);
		execFileSync("/usr/bin/mkfifo", [join(rootPath, "pipe")], { timeout: 3000 });
		await assert.rejects(root.invoke("read", { path: "pipe" }, signal()), /regular/);
		const result = await root.invoke("ls", {}, signal()) as { entries: { name: string; type: string }[] };
		assert(result.entries.some((item) => item.name === "link" && item.type === "symlink"));
		// The authorization is held by a directory descriptor, not a mutable name.
		await rename(rootPath, join(dir, "moved"));
		await symlink(dir, rootPath);
		assert.deepEqual(await root.invoke("read", { path: "file" }, signal()),
			{ text: "abcdef", nextOffset: 6, truncated: false });
	} finally { await root.close(); }
	await assert.rejects(root.invoke("ls", {}, signal()), /revoked/);
});

test("read root: list and read sizes stay bounded", async () => {
	const dir = await scratch("budgets");
	await Promise.all(Array.from({ length: LIMITS.entries + 1 }, (_, i) => writeFile(join(dir, String(i)), "x")));
	await writeFile(join(dir, "big"), "x".repeat(LIMITS.readBytes * 2));
	const root = await ReadRoot.grant(dir);
	try {
		const ls = await root.invoke("ls", {}, signal()) as { entries: unknown[]; truncated: boolean };
		assert.equal(ls.entries.length, LIMITS.entries);
		assert.equal(ls.truncated, true);
		const read = await root.invoke("read", { path: "big" }, signal()) as { text: string; truncated: boolean };
		assert.equal(Buffer.byteLength(read.text), LIMITS.readBytes);
		assert.equal(read.truncated, true);
	} finally { await root.close(); }
});

test("bridge: bounded concurrency/queue and cancellation retain running I/O until settlement", async () => {
	const finishes: (() => void)[] = [];
	let effects = 0;
	const fake = { invoke: async () => {
		effects++;
		await new Promise<void>((resolve) => finishes.push(resolve));
		return {};
	} } as unknown as ReadRoot;
	const controller = new AbortController();
	const bridge = readBridge(fake, controller.signal);
	const calls = Array.from({ length: 20 }, () => bridge.invoke("read", {}));
	void Promise.allSettled(calls);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(effects, 4);
	await assert.rejects(bridge.invoke("read", {}), /queue budget/);
	controller.abort();
	bridge.stop();
	assert.equal(effects, 4);
	for (const finish of finishes) finish();
	await bridge.settled();
	assert.equal(bridge.peak, 4);
	await assert.rejects(bridge.invoke("read", {}));
	assert.equal(effects, 4, "queued and late requests never start after revocation");
	const immediate = readBridge({ invoke: async () => ({}) } as unknown as ReadRoot, signal());
	for (let i = 0; i < LIMITS.calls; i++) await immediate.invoke("read", {});
	await assert.rejects(immediate.invoke("read", {}), /call budget/);
});

function fakeWire() {
	const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
	child.stdin.resume();
	return { child, wire: new Wire(child as unknown as ChildProcessWithoutNullStreams) };
}
function frame(message: unknown): Buffer {
	const data = Buffer.from(JSON.stringify(message));
	const buffer = Buffer.alloc(data.length + 4);
	buffer.writeUInt32LE(data.length);
	data.copy(buffer, 4);
	return buffer;
}

test("official static Host platform gate ignores Node libc but still requires Linux x64", (t) => {
	t.mock.method(process.report, "getReport", () => { throw new Error("Host must not depend on Node libc"); });
	assert.doesNotThrow(verifyPlatform);
	const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
	const arch = Object.getOwnPropertyDescriptor(process, "arch")!;
	try {
		Object.defineProperty(process, "platform", { value: "darwin" });
		assert.throws(verifyPlatform, /Linux x64/);
		Object.defineProperty(process, "platform", platform);
		Object.defineProperty(process, "arch", { value: "arm64" });
		assert.throws(verifyPlatform, /Linux x64/);
	} finally {
		Object.defineProperty(process, "platform", platform);
		Object.defineProperty(process, "arch", arch);
	}
});

test("wire: fragmented frames, malformed responses, budgets and late dispatch", async () => {
	const { child, wire } = fakeWire();
	const ready = wire.expect("connection/ready", 0, signal());
	const data = frame({ type: "connection/ready", selectedVersion: 1 });
	for (const byte of data) child.stdout.write(Buffer.from([byte]));
	assert.deepEqual(await ready, { type: "connection/ready", selectedVersion: 1 });
	const pending = wire.expect("operation/response", 1, signal());
	child.stdout.write(frame({ type: "operation/response", id: 1, result: { status: "invalid" } }));
	await assert.rejects(pending, /Invalid Host operation result/);
	let dispatch = 0;
	wire.onDelegate = () => { dispatch++; };
	child.stdout.write(frame({ type: "delegate/request", id: 1 }));
	assert.equal(dispatch, 0);
	const second = fakeWire();
	const observation = second.wire.expect("connection/ready", 0, signal());
	const header = Buffer.alloc(4);
	header.writeUInt32LE(LIMITS.frameBytes + 1);
	second.child.stdout.write(header);
	await assert.rejects(observation, /frame budget/);
});

test("grant and asset: default deny, invalid executable, queued revoke/authorize", async () => {
	const dir = await scratch("grants");
	const source = join(dir, "not-host");
	await writeFile(source, "do not execute");
	await assert.rejects(prepareHost(source), /pinned/);
	const session = new CodeSession();
	await assert.rejects(session.execute("text(1)"), /explicit/);
	await assert.rejects(session.authorize(dir, ""), /Provide/);
	await session.authorize(dir, source);
	assert.equal(session.enabled, true);
	await assert.rejects(session.execute(" ".repeat(LIMITS.codeBytes + 1)), /Code must/);
	await session.revoke(true);
	assert.equal(session.enabled, false);
	await assert.rejects(session.authorize(dir, source), /closing/);
});

test("bridge: an individually cancelled queued delegate never accesses the filesystem", async () => {
	let effects = 0;
	const finishes: (() => void)[] = [];
	const fake = { invoke: async () => {
		effects++;
		await new Promise<void>((resolve) => finishes.push(resolve));
	} } as unknown as ReadRoot;
	const bridge = readBridge(fake, signal());
	const running = Array.from({ length: 4 }, () => bridge.invoke("read", {}));
	await new Promise((resolve) => setImmediate(resolve));
	const controller = new AbortController();
	const queued = bridge.invoke("read", {}, controller.signal);
	void queued.catch(() => {});
	controller.abort();
	finishes[0]();
	await assert.rejects(queued);
	for (const finish of finishes) finish();
	await Promise.all(running);
	assert.equal(effects, 4);
});

test("supervisor: an unconfirmed stop retains the OS watchdog and rejects cleanup", async () => {
	const invoked: string[][] = [];
	const watchdogs = new Set(["must-remain-armed"]);
	const supervisor = Object.assign(Object.create(Supervisor.prototype), {
		unit: "fixture.service", watchdogs, disarming: new Map(), dead: true,
		exited: Promise.resolve(),
		child: { kill() {}, stdin: { destroy() {} }, stdout: { destroy() {} }, stderr: { destroy() {} } },
		command: async (_command: string, args: string[]) => {
			invoked.push(args);
			if (args.includes("show")) return "active";
			throw new Error("fixture bus failure");
		},
	}) as Supervisor;
	await assert.rejects(supervisor.stop(), /bus failure/);
	assert.equal(watchdogs.size, 1);
	assert(!invoked.some((args) => args.some((arg) => arg.includes("must-remain-armed"))));
});
