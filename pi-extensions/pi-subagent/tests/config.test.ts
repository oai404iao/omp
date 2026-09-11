import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { DEFAULT_SETTINGS, loadSettings } from "../src/config.ts";

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
			runtimeMode: "foreground",
			maxConcurrentBackgroundRuns: 7,
			maxIdleRuntimes: 5,
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
	assert.equal(loaded.settings.inheritExtensions, true);
	assert.equal(loaded.settings.openAIIdentity, true);
	assert.equal(loaded.settings.runtimeMode, "foreground");
	assert.equal(loaded.settings.maxConcurrentBackgroundRuns, 2);
	assert.equal(loaded.settings.maxIdleRuntimes, 1);
	assert.equal(loaded.sources.length, 2);
	assert.deepEqual(Object.keys(loaded.settings).sort(), [
		"agentScope",
		"inheritExtensions",
		"maxConcurrentBackgroundRuns",
		"maxDepth",
		"maxIdleRuntimes",
		"maxOutputBytes",
		"openAIIdentity",
		"runtimeMode",
	]);
});

test("untrusted project configuration is not read", () => {
	const root = tempRoot();
	const agentDir = join(root, "agent");
	const project = join(root, "repo");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(project, ".pi"), { recursive: true });
	writeFileSync(join(project, ".pi", "subagent.json"), "{not-json");

	const loaded = loadSettings({ cwd: project, projectTrusted: false, agentDir });
	assert.deepEqual(loaded.settings, DEFAULT_SETTINGS);
	assert.deepEqual(loaded.sources, []);
});

test("invalid settings fail loud", () => {
	const root = tempRoot();
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	const configPath = join(agentDir, "subagent.json");
	for (const [body, pattern] of [
		[{ maxDepth: -1 }, /maxDepth must be a safe integer/],
		[{ maxConcurrentBackgroundRuns: 0 }, /maxConcurrentBackgroundRuns must be a safe integer/],
		[{ maxIdleRuntimes: -1 }, /maxIdleRuntimes must be a safe integer/],
		[{ runtimeMode: "sometimes" }, /runtimeMode must be "foreground" or "background"/],
		[{ agentScope: "everyone" }, /agentScope must be "user", "project", or "both"/],
		[{ maxOutputBytes: 10 }, /maxOutputBytes must be a safe integer/],
		[{ inheritExtensions: "yes" }, /inheritExtensions must be a boolean/],
	] as const) {
		writeFileSync(configPath, JSON.stringify(body));
		assert.throws(
			() => loadSettings({ cwd: root, projectTrusted: false, agentDir }),
			pattern,
		);
	}
});

test("retired settings and the removed report delivery key fail loud", () => {
	const root = tempRoot();
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	const configPath = join(agentDir, "subagent.json");
	for (const retired of [
		"enableRunInBackground",
		"defaultBackground",
		"backgroundProtocol",
		"syncBundledAgents",
		"reportDelivery",
	]) {
		writeFileSync(configPath, JSON.stringify({ [retired]: true }));
		assert.throws(
			() => loadSettings({ cwd: root, projectTrusted: false, agentDir }),
			new RegExp(`unknown setting "${retired}"`),
			`${retired} must be rejected`,
		);
	}
});

test("configuration is never rewritten by the extension", () => {
	const root = tempRoot();
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	const configPath = join(agentDir, "subagent.json");
	const original = `${JSON.stringify({ runtimeMode: "foreground", maxDepth: 2 }, null, 2)}\n`;
	writeFileSync(configPath, original);
	const loaded = loadSettings({ cwd: root, projectTrusted: false, agentDir });
	assert.equal(loaded.settings.runtimeMode, "foreground");
	assert.equal(loaded.settings.maxDepth, 2);
	assert.equal(readFileSync(configPath, "utf8"), original);
});
