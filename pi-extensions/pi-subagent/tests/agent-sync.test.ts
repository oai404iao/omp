import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { syncBundledAgents } from "../src/agent-sync.ts";

const roots: string[] = [];

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-subagent-sync-"));
	roots.push(root);
	return root;
}

function writeBundled(dir: string, name: string, body: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${name}.md`), body);
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("initial startup materializes bundled agents in the user directory", () => {
	const root = tempRoot();
	const bundledDir = join(root, "bundled");
	const agentDir = join(root, "agent");
	writeBundled(bundledDir, "scout", "bundled scout v1\n");
	writeBundled(bundledDir, "worker", "bundled worker v1\n");

	const result = syncBundledAgents({ bundledDir, agentDir, packageVersion: "1.0.0" });
	assert.deepEqual(result.installed, ["scout.md", "worker.md"]);
	assert.deepEqual(result.updated, []);
	assert.equal(readFileSync(join(agentDir, "agents", "scout.md"), "utf8"), "bundled scout v1\n");
	assert.equal(JSON.parse(readFileSync(result.manifestPath, "utf8")).packageVersion, "1.0.0");
});

test("same-version restarts preserve edits, then an update backs up and replaces them", () => {
	const root = tempRoot();
	const bundledDir = join(root, "bundled");
	const agentDir = join(root, "agent");
	writeBundled(bundledDir, "scout", "bundled scout v1\n");
	syncBundledAgents({ bundledDir, agentDir, packageVersion: "1.0.0" });

	const userScout = join(agentDir, "agents", "scout.md");
	writeFileSync(userScout, "my customized scout\n");
	const restart = syncBundledAgents({ bundledDir, agentDir, packageVersion: "1.0.0" });
	assert.equal(readFileSync(userScout, "utf8"), "my customized scout\n");
	assert.deepEqual(restart.updated, []);
	assert.deepEqual(restart.backups, []);

	writeBundled(bundledDir, "scout", "bundled scout v2\n");
	const update = syncBundledAgents({ bundledDir, agentDir, packageVersion: "2.0.0" });
	assert.deepEqual(update.updated, ["scout.md"]);
	assert.equal(update.backups.length, 1);
	assert.equal(readFileSync(update.backups[0].path, "utf8"), "my customized scout\n");
	assert.equal(readFileSync(userScout, "utf8"), "bundled scout v2\n");
});

test("a deleted preset is never restored by a later package version", () => {
	const root = tempRoot();
	const bundledDir = join(root, "bundled");
	const agentDir = join(root, "agent");
	writeBundled(bundledDir, "scout", "bundled scout v1\n");
	writeBundled(bundledDir, "worker", "bundled worker v1\n");
	syncBundledAgents({ bundledDir, agentDir, packageVersion: "1.0.0" });

	const userScout = join(agentDir, "agents", "scout.md");
	unlinkSync(userScout);
	const restart = syncBundledAgents({ bundledDir, agentDir, packageVersion: "1.0.0" });
	assert.equal(existsSync(userScout), false);
	assert.deepEqual(restart.installed, []);
	assert.deepEqual(restart.updated, []);
	assert.deepEqual(restart.removed, []);
	assert.deepEqual(restart.retired, ["scout.md"]);
	assert.equal(restart.retirementChanged, true);
	assert.deepEqual(restart.backups, []);

	const update = syncBundledAgents({ bundledDir, agentDir, packageVersion: "2.0.0" });
	assert.deepEqual(update.installed, []);
	assert.deepEqual(update.retired, ["scout.md"]);
	assert.equal(update.retirementChanged, false);
	assert.equal(existsSync(userScout), false);
	assert.equal(
		JSON.parse(readFileSync(update.manifestPath, "utf8")).retired.join(","),
		"scout.md",
	);

	// The deletion is recorded once and reported only when it changes, but the
	// durable retirement list stays observable.
	const settled = syncBundledAgents({ bundledDir, agentDir, packageVersion: "2.0.0" });
	assert.deepEqual(settled.retired, ["scout.md"]);
	assert.equal(settled.retirementChanged, false);
	assert.deepEqual(settled.installed, []);
});

test("a deletion recorded by an older release is honored on upgrade", () => {
	const root = tempRoot();
	const bundledDir = join(root, "bundled");
	const agentDir = join(root, "agent");
	writeBundled(bundledDir, "scout", "bundled scout\n");
	writeBundled(bundledDir, "worker", "bundled worker\n");
	const first = syncBundledAgents({ bundledDir, agentDir, packageVersion: "1.0.0" });
	const manifest = JSON.parse(readFileSync(first.manifestPath, "utf8"));
	delete manifest.retired;
	writeFileSync(first.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	unlinkSync(join(agentDir, "agents", "scout.md"));

	const update = syncBundledAgents({ bundledDir, agentDir, packageVersion: "2.0.0" });
	assert.deepEqual(update.retired, ["scout.md"]);
	assert.deepEqual(update.installed, []);
	assert.equal(existsSync(join(agentDir, "agents", "scout.md")), false);
	assert.equal(existsSync(join(agentDir, "agents", "worker.md")), true);
});

test("a preset added by a later release is still installed after deletions", () => {
	const root = tempRoot();
	const bundledDir = join(root, "bundled");
	const agentDir = join(root, "agent");
	writeBundled(bundledDir, "scout", "bundled scout v1\n");
	writeBundled(bundledDir, "worker", "bundled worker v1\n");
	syncBundledAgents({ bundledDir, agentDir, packageVersion: "1.0.0" });
	unlinkSync(join(agentDir, "agents", "worker.md"));
	syncBundledAgents({ bundledDir, agentDir, packageVersion: "1.0.0" });

	writeBundled(bundledDir, "planner", "bundled planner v1\n");
	const update = syncBundledAgents({ bundledDir, agentDir, packageVersion: "2.0.0" });
	assert.deepEqual(update.installed, ["planner.md"]);
	assert.equal(existsSync(join(agentDir, "agents", "worker.md")), false);
	assert.equal(readFileSync(join(agentDir, "agents", "planner.md"), "utf8"), "bundled planner v1\n");
});

test("recreating a deleted preset makes it a managed preset again", () => {
	const root = tempRoot();
	const bundledDir = join(root, "bundled");
	const agentDir = join(root, "agent");
	writeBundled(bundledDir, "scout", "bundled scout v1\n");
	syncBundledAgents({ bundledDir, agentDir, packageVersion: "1.0.0" });
	const userScout = join(agentDir, "agents", "scout.md");
	unlinkSync(userScout);
	syncBundledAgents({ bundledDir, agentDir, packageVersion: "1.0.0" });

	writeFileSync(userScout, "restored custom scout\n");
	const restored = syncBundledAgents({ bundledDir, agentDir, packageVersion: "1.0.0" });
	assert.deepEqual(restored.restored, ["scout.md"]);
	assert.deepEqual(restored.retired, []);
	assert.equal(restored.retirementChanged, true);
	assert.equal(readFileSync(userScout, "utf8"), "restored custom scout\n");

	writeBundled(bundledDir, "scout", "bundled scout v2\n");
	const update = syncBundledAgents({ bundledDir, agentDir, packageVersion: "2.0.0" });
	assert.deepEqual(update.updated, ["scout.md"]);
	assert.deepEqual(update.installed, []);
	assert.equal(update.backups.length, 1);
	assert.equal(readFileSync(update.backups[0].path, "utf8"), "restored custom scout\n");
	assert.equal(readFileSync(userScout, "utf8"), "bundled scout v2\n");
});

test("deleting every initialized role leaves the same-version catalog empty", () => {
	const root = tempRoot();
	const bundledDir = join(root, "bundled");
	const agentDir = join(root, "agent");
	writeBundled(bundledDir, "planner", "bundled planner\n");
	writeBundled(bundledDir, "reviewer", "bundled reviewer\n");
	syncBundledAgents({ bundledDir, agentDir, packageVersion: "1.0.0" });
	rmSync(join(agentDir, "agents"), { recursive: true, force: true });

	const restart = syncBundledAgents({ bundledDir, agentDir, packageVersion: "1.0.0" });
	assert.deepEqual(readdirSync(restart.userAgentsDir), []);
	assert.deepEqual(restart.installed, []);
});

test("a bundled prompt change is ignored without a package version change", () => {
	const root = tempRoot();
	const bundledDir = join(root, "bundled");
	const agentDir = join(root, "agent");
	writeBundled(bundledDir, "planner", "bundled planner v1\n");
	syncBundledAgents({ bundledDir, agentDir, packageVersion: "1.0.0" });
	const userPlanner = join(agentDir, "agents", "planner.md");
	writeFileSync(userPlanner, "custom planner\n");
	writeBundled(bundledDir, "planner", "bundled planner changed\n");

	const update = syncBundledAgents({ bundledDir, agentDir, packageVersion: "1.0.0" });
	assert.deepEqual(update.updated, []);
	assert.deepEqual(update.backups, []);
	assert.equal(readFileSync(userPlanner, "utf8"), "custom planner\n");
});

test("a corrupt manifest skips initialization without blocking user roles", () => {
	const root = tempRoot();
	const bundledDir = join(root, "bundled");
	const agentDir = join(root, "agent");
	writeBundled(bundledDir, "reviewer", "bundled reviewer\n");
	const first = syncBundledAgents({ bundledDir, agentDir, packageVersion: "1.0.0" });
	const userReviewer = join(agentDir, "agents", "reviewer.md");
	writeFileSync(userReviewer, "custom reviewer\n");
	writeFileSync(first.manifestPath, "{broken");

	const result = syncBundledAgents({ bundledDir, agentDir, packageVersion: "1.0.0" });
	assert.match(result.diagnostics.join("\n"), /invalid manifest/);
	assert.match(result.diagnostics.join("\n"), /user\/project agents remain available/);
	assert.deepEqual(result.installed, []);
	assert.equal(readFileSync(first.manifestPath, "utf8"), "{broken");
	assert.equal(readFileSync(userReviewer, "utf8"), "custom reviewer\n");
	assert.equal(
		readdirSync(dirname(first.manifestPath)).some((name) =>
			name.startsWith("agents-manifest.json.corrupt-"),
		),
		true,
	);
});

test("retired bundled presets are backed up and removed", () => {
	const root = tempRoot();
	const bundledDir = join(root, "bundled");
	const agentDir = join(root, "agent");
	writeBundled(bundledDir, "scout", "bundled scout\n");
	writeBundled(bundledDir, "worker", "bundled worker\n");
	syncBundledAgents({ bundledDir, agentDir, packageVersion: "1.0.0" });
	const userScout = join(agentDir, "agents", "scout.md");
	writeFileSync(userScout, "custom retired scout\n");
	unlinkSync(join(bundledDir, "scout.md"));

	const update = syncBundledAgents({ bundledDir, agentDir, packageVersion: "2.0.0" });
	assert.deepEqual(update.removed, ["scout.md"]);
	assert.equal(update.backups.length, 1);
	assert.equal(readFileSync(update.backups[0].path, "utf8"), "custom retired scout\n");
	assert.equal(existsSync(userScout), false);
	assert.equal(readFileSync(join(agentDir, "agents", "worker.md"), "utf8"), "bundled worker\n");
});

test("same-name symbolic links are backed up as links before replacement", () => {
	const root = tempRoot();
	const bundledDir = join(root, "bundled");
	const agentDir = join(root, "agent");
	const userAgentsDir = join(agentDir, "agents");
	const target = join(root, "linked-scout.md");
	writeBundled(bundledDir, "scout", "bundled scout\n");
	mkdirSync(userAgentsDir, { recursive: true });
	writeFileSync(target, "linked custom scout\n");
	symlinkSync(target, join(userAgentsDir, "scout.md"));

	const result = syncBundledAgents({ bundledDir, agentDir, packageVersion: "1.0.0" });
	assert.equal(result.updated[0], "scout.md");
	assert.equal(result.backups[0].kind, "symlink");
	assert.equal(lstatSync(result.backups[0].path).isSymbolicLink(), true);
	assert.equal(readlinkSync(result.backups[0].path), target);
	assert.equal(lstatSync(join(userAgentsDir, "scout.md")).isFile(), true);
	assert.equal(readFileSync(join(userAgentsDir, "scout.md"), "utf8"), "bundled scout\n");
});

test("preflight rejects a later invalid destination without changing earlier presets", () => {
	const root = tempRoot();
	const bundledDir = join(root, "bundled");
	const agentDir = join(root, "agent");
	writeBundled(bundledDir, "scout", "bundled scout v1\n");
	writeBundled(bundledDir, "worker", "bundled worker v1\n");
	syncBundledAgents({ bundledDir, agentDir, packageVersion: "1.0.0" });
	const userScout = join(agentDir, "agents", "scout.md");
	const userWorker = join(agentDir, "agents", "worker.md");
	writeFileSync(userScout, "custom scout\n");
	unlinkSync(userWorker);
	mkdirSync(userWorker);
	writeBundled(bundledDir, "scout", "bundled scout v2\n");
	writeBundled(bundledDir, "worker", "bundled worker v2\n");

	assert.throws(
		() => syncBundledAgents({ bundledDir, agentDir, packageVersion: "2.0.0" }),
		/managed agent destination must be a regular file or symbolic link/,
	);
	assert.equal(readFileSync(userScout, "utf8"), "custom scout\n");
});

test("agent synchronization waits for an active cross-process lock", async () => {
	const root = tempRoot();
	const bundledDir = join(root, "bundled");
	const agentDir = join(root, "agent");
	const lockPath = join(agentDir, ".pi-subagent", "sync.lock");
	writeBundled(bundledDir, "scout", "bundled scout\n");
	const child = spawn(
		process.execPath,
		[
			"-e",
			`
const fs = require("node:fs");
const lockPath = process.argv[1];
const wait = () => {
	if (!fs.existsSync(lockPath)) return setTimeout(wait, 5);
	setTimeout(() => fs.rmSync(lockPath, { recursive: true, force: true }), 200);
};
wait();
`,
			lockPath,
		],
		{ stdio: "ignore" },
	);
	assert.ok(child.pid);
	const childExit = once(child, "exit");
	mkdirSync(lockPath, { recursive: true });
	writeFileSync(
		join(lockPath, "owner.json"),
		JSON.stringify({
			pid: child.pid,
			hostname: hostname(),
			token: "live-test-owner",
			createdAt: new Date().toISOString(),
		}),
	);

	const startedAt = Date.now();
	const result = syncBundledAgents({ bundledDir, agentDir, packageVersion: "1.0.0" });
	const elapsed = Date.now() - startedAt;
	await childExit;
	assert.ok(elapsed >= 100, `expected lock wait, observed ${elapsed}ms`);
	assert.deepEqual(result.installed, ["scout.md"]);
});

test("agent synchronization reclaims only a confirmed dead local owner", async () => {
	const root = tempRoot();
	const bundledDir = join(root, "bundled");
	const agentDir = join(root, "agent");
	const lockPath = join(agentDir, ".pi-subagent", "sync.lock");
	writeBundled(bundledDir, "worker", "bundled worker\n");
	const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
	assert.ok(child.pid);
	await once(child, "exit");
	mkdirSync(lockPath, { recursive: true });
	writeFileSync(
		join(lockPath, "owner.json"),
		JSON.stringify({
			pid: child.pid,
			hostname: hostname(),
			token: "dead-test-owner",
			createdAt: new Date().toISOString(),
		}),
	);

	const result = syncBundledAgents({ bundledDir, agentDir, packageVersion: "1.0.0" });
	assert.deepEqual(result.installed, ["worker.md"]);
	assert.equal(existsSync(lockPath), false);
});
