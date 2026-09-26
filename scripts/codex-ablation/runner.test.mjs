import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runIsolatedTests } from "./run-isolated.mjs";

test("runner deadline kills a deliberately stalled test worker, not just its parent", {
	skip: process.platform !== "linux",
}, async () => {
	const root = process.env.TMPDIR ?? join(homedir(), ".local/state/agents/tmp");
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const dir = mkdtempSync(join(root, "codex-ablation-deadline-"));
	const fixture = join(dir, "stalled.test.mjs");
	const pidFile = join(dir, "worker.pid");
	writeFileSync(fixture, `
		import test from "node:test";
		import { writeFileSync } from "node:fs";
		test("stalled worker", async () => {
			writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
			await new Promise(() => { setInterval(() => {}, 1000); });
		});
	`);
	const result = await runIsolatedTests(["--test", fixture], {
		cwd: dir, env: { PATH: process.env.PATH }, logPath: join(dir, "deadline.tap"), timeoutMs: 1500,
	});
	assert.equal(result.signal, "SIGKILL");
	assert.equal(result.stopReason, "1500ms experiment deadline");
	assert.equal(result.error, undefined);
	const pid = readFileSync(pidFile, "utf8").trim();
	try {
		// A killed orphan may briefly remain a zombie until the system reaps it.
		const status = readFileSync(`/proc/${pid}/status`, "utf8");
		assert.match(status, /^State:\s+Z\b/m, "worker must not remain running after the deadline");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
});
