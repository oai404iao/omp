import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { Supervisor } from "./supervisor.ts";
import { LIMITS } from "./limits.ts";
import type { ReadRoot } from "./readonly.ts";

import { UnsettledEffect } from "./errors.ts";
export { UnsettledEffect } from "./errors.ts";
export const processSchema = Type.Object({
	command: Type.String({ minLength: 1, maxLength: 12000 }),
	timeout_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: LIMITS.executionMs })),
}, { additionalProperties: false });

export async function runProcess(root: ReadRoot, args: unknown, signal: AbortSignal): Promise<unknown> {
	if (!Check(processSchema, args)) throw new Error("Invalid process arguments");
	const { command, timeout_ms = 30000 } = args as { command: string; timeout_ms?: number };
	if (Buffer.byteLength(command) > 12000) throw new Error("Process command budget exceeded");
	signal.throwIfAborted();
	const state = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "pi-code-mode");
	await mkdir(state, { recursive: true, mode: 0o700 });
	const directory = await mkdtemp(join(state, "process-"));
	signal.throwIfAborted();
	signal.throwIfAborted();
	// No user code executes before READY -> verified cgroup -> armed timer -> GO.
	const gate = "printf 'CODE_MODE_READY\\n'; IFS= read -r gate; test \"$gate\" = GO || exit 125; exec /bin/bash --noprofile --norc -c \"$1\"";
	const supervisor = new Supervisor("/bin/bash", directory, {
		args: ["--noprofile", "--norc", "-c", gate, "code-mode-gate", command],
		cwd: root.processCwd, path: process.env.PATH ?? "/usr/bin:/bin",
	});
	let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), bytes = 0;
	let failure: Error | undefined;
	let started = false;
	let readyResolve!: () => void;
	let readyReject!: (error: Error) => void;
	const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
	void ready.catch(() => {});
	const fail = (error: Error) => { failure ??= error; readyReject(error); void supervisor.stop().catch(() => {}); };
	supervisor.child.on("error", fail);
	supervisor.child.stdin.on("error", fail);
	supervisor.child.stdout.on("data", (chunk: Buffer) => {
		if (failure) return;
		if (!started) {
			stdout = Buffer.concat([stdout, chunk]);
			if (stdout.length > 1024) { fail(new Error("Invalid process gate")); return; }
			if (stdout.toString() === "CODE_MODE_READY\n") { started = true; stdout = Buffer.alloc(0); readyResolve(); }
			return;
		}
		bytes += chunk.length;
		if (bytes > LIMITS.outputBytes) fail(new Error("Process output budget exceeded"));
		else stdout = Buffer.concat([stdout, chunk]);
	});
	supervisor.child.stderr.on("data", (chunk: Buffer) => {
		if (failure) return;
		bytes += chunk.length;
		if (bytes > LIMITS.outputBytes) fail(new Error("Process output budget exceeded"));
		else stderr = Buffer.concat([stderr, chunk]);
	});
	const abort = () => fail(new Error("Process cancelled; side effects are not rolled back"));
	signal.addEventListener("abort", abort, { once: true });
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		timer = setTimeout(() => fail(new Error("Process startup deadline exceeded")), 10000);
		void supervisor.exited.then(() => { if (!started) readyReject(new Error("Process gate exited before readiness")); });
		await ready;
		await supervisor.verify(signal);
		await supervisor.arm(signal, Math.ceil(timeout_ms / 1000) + 5);
		signal.throwIfAborted();
		clearTimeout(timer);
		timer = setTimeout(() => fail(new Error("Process timeout; side effects are not rolled back")), timeout_ms);
		supervisor.child.stdin.end("GO\n");
		await supervisor.exited;
		if (failure) throw failure;
		return { stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), exitCode: supervisor.child.exitCode };
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
		try { await supervisor.stop(); }
		catch (error) { throw new UnsettledEffect(`Process stop is unconfirmed; Code Mode is blocked: ${String(error)}`); }
	}
}
