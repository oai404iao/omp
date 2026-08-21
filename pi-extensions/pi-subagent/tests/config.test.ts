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
			reportDelivery: "quiet",
			inheritExtensions: true,
			openAIIdentity: true,
		}),
	);
	writeFileSync(
		join(root, "repo", ".pi", "subagent.json"),
		JSON.stringify({ maxDepth: 2, agentScope: "both" }),
	);

	const loaded = loadSettings({ cwd: project, projectTrusted: true, agentDir });
	assert.equal(loaded.settings.maxDepth, 2);
	assert.equal(loaded.settings.agentScope, "both");
	assert.equal(loaded.settings.reportDelivery, "quiet");
	assert.equal(loaded.settings.inheritExtensions, true);
	assert.equal(loaded.settings.openAIIdentity, true);
	assert.equal(loaded.settings.enableRunInBackground, false);
	assert.equal(loaded.settings.syncBundledAgents, true);
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
	assert.equal(loaded.settings.syncBundledAgents, false);
	assert.equal(loaded.settings.openAIIdentity, false);
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
});

test("syncBundledAgents must be a boolean", () => {
	const root = tempRoot();
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "subagent.json"), JSON.stringify({ syncBundledAgents: "yes" }));
	assert.throws(
		() => loadSettings({ cwd: root, projectTrusted: false, agentDir }),
		/syncBundledAgents must be a boolean/,
	);
});

test("trusted project configuration cannot enable bundled-agent synchronization", () => {
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
