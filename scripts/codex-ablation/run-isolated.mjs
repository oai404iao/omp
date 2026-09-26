import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

export async function runIsolatedTests(args, { cwd, env, logPath, timeoutMs }) {
	assert.notEqual(process.platform, "win32", "This offline experiment runner requires POSIX process groups.");
	const log = createWriteStream(logPath);
	const child = spawn(process.execPath, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
	let stopReason;
	let error;
	const stop = (reason) => {
		if (stopReason) return;
		stopReason = reason;
		if (!child.pid) return;
		try { process.kill(-child.pid, "SIGKILL"); }
		catch (failure) { if (failure.code !== "ESRCH") error = failure.message; }
	};
	const interrupt = () => stop("SIGINT");
	const terminate = () => stop("SIGTERM");
	process.on("SIGINT", interrupt);
	process.on("SIGTERM", terminate);
	const deadline = setTimeout(() => stop(`${timeoutMs}ms experiment deadline`), timeoutMs);
	log.on("error", (failure) => { error = failure.message; stop("evidence log failed"); });
	child.on("error", (failure) => { error = failure.message; });
	for (const stream of [child.stdout, child.stderr]) {
		stream.on("data", (data) => { process.stdout.write(data); log.write(data); });
	}
	return new Promise((resolve) => {
		child.on("close", (code, signal) => {
			clearTimeout(deadline);
			process.off("SIGINT", interrupt);
			process.off("SIGTERM", terminate);
			log.end(() => resolve({ code, signal, error, stopReason, endedAt: new Date().toISOString() }));
		});
	});
}
