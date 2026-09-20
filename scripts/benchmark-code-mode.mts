import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { CodeSession } from "../pi-extensions/pi-code-mode/src/session.ts";
import { Supervisor, control } from "../pi-extensions/pi-code-mode/src/supervisor.ts";
import { Wire } from "../pi-extensions/pi-code-mode/src/wire.ts";

assert.equal(process.argv[2], "--host", "usage: npm exec -- tsx scripts/benchmark-code-mode.mts --host /pinned/host");
const host = process.argv[3];
assert(host && process.argv.length === 4);
const root = join(homedir(), ".local/state/agents/tmp");
await mkdir(root, { recursive: true, mode: 0o700 });
const task = await mkdtemp(join(root, "code-mode-benchmark-"));
const cwd = join(task, "cwd");
const state = join(task, "state");
await mkdir(cwd); await mkdir(state);
process.env.XDG_STATE_HOME = state;
await writeFile(join(cwd, "fixture.txt"), "benchmark read\n".repeat(100));
const counts = { hostSpawns: 0, systemdCommands: 0, ipcFrames: 0, waitPolls: 0, peakRssBytes: 0, peakPiRssBytes: 0 };
const pids = new Set<string>();
const originalVerify = Supervisor.prototype.verify;
Supervisor.prototype.verify = async function (signal) {
	counts.hostSpawns++;
	const self = this as unknown as { command: typeof control };
	const command = self.command;
	self.command = (...args) => { counts.systemdCommands++; return command(...args); };
	const result = await originalVerify.call(this, signal);
	pids.add(await control("/usr/bin/systemctl", ["--user", "show", this.unit, "--property=MainPID", "--value"]));
	return result;
};
const originalSend = Wire.prototype.send;
Wire.prototype.send = function (message) {
	counts.ipcFrames++;
	if ((message as { request?: { method?: string } }).request?.method === "session/wait") counts.waitPolls++;
	return originalSend.call(this, message);
};
const sampleMemory = async () => {
	counts.peakPiRssBytes = Math.max(counts.peakPiRssBytes, process.memoryUsage().rss);
	for (const pid of pids) {
		try {
			const text = await readFile(`/proc/${pid}/status`, "utf8");
			const kb = Number(text.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0);
			counts.peakRssBytes = Math.max(counts.peakRssBytes, kb * 1024);
		} catch { pids.delete(pid); }
	}
};
const sampler = setInterval(() => { void sampleMemory(); }, 25);
sampler.unref();
const session = new CodeSession();
const samples: Record<string, number[]> = {};
async function measured(name: string, action: () => Promise<unknown>) {
	const start = performance.now();
	await action();
	(samples[name] ??= []).push(performance.now() - start);
	await sampleMemory();
}
async function run(source: string) {
	let result = await session.execute(source, undefined, { yield_time_ms: 5000 });
	while (["running", "settling", "terminating"].includes(result.state) || result.hasMoreOutput) {
		result = await session.wait(result.cellId, { yield_time_ms: 5000 });
	}
	assert.equal(result.failed, false, result.error ?? "benchmark execution");
}
async function disk(path: string): Promise<number> {
	let bytes = 0;
	for (const item of await readdir(path, { withFileTypes: true })) {
		const file = join(path, item.name);
		if (item.isDirectory()) bytes += await disk(file);
		else if (item.isFile()) bytes += (await stat(file)).size;
	}
	return bytes;
}
try {
	await session.authorize(cwd, host);
	for (let i = 0; i < 5; i++) {
		await measured("coldText", () => run("text(1)"));
		await session.invalidate();
	}
	await run("text(1)");
	for (let i = 0; i < 5; i++) {
		await run("text(0)"); // an immediately-cancelled start may have reset the Host
		await measured("warmText", () => run("text(1)"));
		await measured("read", () => run('text((await tools.read({path:"fixture.txt"})).text.length)'));
		await measured("parallelRead", () => run('text(await Promise.all([1,2,3,4].map(async()=> (await tools.read({path:"fixture.txt"})).text.length)))'));
		await measured("delayed", () => run('await new Promise(r=>setTimeout(r,100));text(1)'));
		const cell = await session.execute("await new Promise(()=>{})", undefined, { yield_time_ms: 0 });
		await measured("cancel", async () => {
			let result = await session.wait(cell.cellId, { terminate: true, yield_time_ms: 5000 });
			while (["running", "settling", "terminating"].includes(result.state)) result = await session.wait(cell.cellId, { yield_time_ms: 5000 });
			assert.equal(result.failed, false);
		});
	}
} finally {
	await session.revoke(true);
	clearInterval(sampler);
	Supervisor.prototype.verify = originalVerify;
	Wire.prototype.send = originalSend;
}
const summary = Object.fromEntries(Object.entries(samples).map(([name, values]) => {
	const sorted = [...values].sort((a, b) => a - b);
	return [name, { samples: values.length, p50Ms: sorted[Math.ceil(sorted.length * .5) - 1], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1] }];
}));
const evidence = { node: process.version, samples, summary, ...counts,
	systemdCalls: counts.systemdCommands + counts.hostSpawns, retainedBytes: await disk(state),
	note: "5 samples/workload; P95 is the maximum sample. Includes observer/watchdog overhead. Instrumentation queries excluded from systemd counts. RSS sampled at 25ms, not kernel peak." };
await writeFile(join(task, "results.json"), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(task);
console.log(JSON.stringify(evidence, null, 2));
