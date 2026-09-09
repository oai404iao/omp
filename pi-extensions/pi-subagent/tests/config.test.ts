import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { loadSettings } from "../src/config.ts";

const roots: string[] = [];

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-subagent-config-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("global and trusted project settings merge", () => {
	const root = tempRoot();
	const agentDir = join(root, "agent");
	const project = join(root, "repo", "nested");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(root, "repo", ".pi"), { recursive: true });
	mkdirSync(project, { recursive: true });
	writeFileSync(
		join(agentDir, "subagent.json"),
		JSON.stringify({
			maxDepth: 5,
			syncBundledAgents: true,
			enableRunInBackground: false,
			maxConcurrentBackgroundRuns: 7,
			maxIdleRuntimes: 5,
			backgroundProtocol: "mailbox-v2",
			reportDelivery: "quiet",
			inheritExtensions: true,
			openAIIdentity: true,
		}),
	);
	writeFileSync(
		join(root, "repo", ".pi", "subagent.json"),
		JSON.stringify({
			maxDepth: 2,
			agentScope: "both",
			maxConcurrentBackgroundRuns: 2,
			maxIdleRuntimes: 1,
		}),
	);

	const loaded = loadSettings({ cwd: project, projectTrusted: true, agentDir });
	assert.equal(loaded.settings.maxDepth, 2);
	assert.equal(loaded.settings.agentScope, "both");
	assert.equal(loaded.settings.reportDelivery, "quiet");
	assert.equal(loaded.settings.inheritExtensions, true);
	assert.equal(loaded.settings.openAIIdentity, true);
	assert.equal(loaded.settings.enableRunInBackground, false);
	assert.equal(loaded.settings.maxConcurrentBackgroundRuns, 2);
	assert.equal(loaded.settings.maxIdleRuntimes, 1);
	assert.equal(loaded.settings.backgroundProtocol, "mailbox-v2");
	assert.equal("syncBundledAgents" in loaded.settings, false);
	assert.equal(loaded.sources.length, 2);
});

test("untrusted project configuration is not read", () => {
	const root = tempRoot();
	const agentDir = join(root, "agent");
	const project = join(root, "repo");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(project, ".pi"), { recursive: true });
	writeFileSync(join(project, ".pi", "subagent.json"), "{not-json");

	const loaded = loadSettings({ cwd: project, projectTrusted: false, agentDir });
	assert.equal(loaded.settings.maxDepth, 3);
	assert.equal("syncBundledAgents" in loaded.settings, false);
	assert.equal(loaded.settings.openAIIdentity, false);
	assert.equal(loaded.settings.maxConcurrentBackgroundRuns, 4);
	assert.equal(loaded.settings.maxIdleRuntimes, 0);
	assert.equal(loaded.settings.backgroundProtocol, "legacy");
	assert.deepEqual(loaded.sources, []);
});

test("invalid settings fail loud", () => {
	const root = tempRoot();
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "subagent.json"), JSON.stringify({ maxDepth: -1 }));
	assert.throws(
		() => loadSettings({ cwd: root, projectTrusted: false, agentDir }),
		/maxDepth must be a safe integer/,
	);
	writeFileSync(
		join(agentDir, "subagent.json"),
		JSON.stringify({ maxConcurrentBackgroundRuns: 0 }),
	);
	assert.throws(
		() => loadSettings({ cwd: root, projectTrusted: false, agentDir }),
		/maxConcurrentBackgroundRuns must be a safe integer/,
	);
	writeFileSync(
		join(agentDir, "subagent.json"),
		JSON.stringify({ maxIdleRuntimes: -1 }),
	);
	assert.throws(
		() => loadSettings({ cwd: root, projectTrusted: false, agentDir }),
		/maxIdleRuntimes must be a safe integer/,
	);
	writeFileSync(
		join(agentDir, "subagent.json"),
		JSON.stringify({ backgroundProtocol: "mailbox-v3" }),
	);
	assert.throws(
		() => loadSettings({ cwd: root, projectTrusted: false, agentDir }),
		/backgroundProtocol must be "legacy" or "mailbox-v2"/,
	);
});

test("the retired user-level syncBundledAgents setting is validated then ignored", () => {
	const root = tempRoot();
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "subagent.json"), JSON.stringify({ syncBundledAgents: false }));
	const loaded = loadSettings({ cwd: root, projectTrusted: false, agentDir });
	assert.equal("syncBundledAgents" in loaded.settings, false);

	writeFileSync(join(agentDir, "subagent.json"), JSON.stringify({ syncBundledAgents: "yes" }));
	assert.throws(
		() => loadSettings({ cwd: root, projectTrusted: false, agentDir }),
		/syncBundledAgents must be a boolean/,
	);
});

test("the retired syncBundledAgents compatibility key remains user-level only", () => {
	const root = tempRoot();
	const agentDir = join(root, "agent");
	const project = join(root, "repo");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(project, ".pi"), { recursive: true });
	writeFileSync(
		join(project, ".pi", "subagent.json"),
		JSON.stringify({ syncBundledAgents: true }),
	);
	assert.throws(
		() => loadSettings({ cwd: project, projectTrusted: true, agentDir }),
		/syncBundledAgents may be configured only in the user-level/,
	);
});
