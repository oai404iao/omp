import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { discoverAgents } from "../src/agents.ts";

const roots: string[] = [];

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-subagent-agents-"));
	roots.push(root);
	return root;
}

function writeAgent(dir: string, name: string, description: string, extra = ""): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `${name}.md`),
		`---\nname: ${name}\ndescription: ${description}\n${extra}---\n\nInstructions for ${name}.\n`,
	);
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("project definitions override user and bundled definitions", () => {
	const root = tempRoot();
	const bundled = join(root, "bundled");
	const agentDir = join(root, "agent");
	const project = join(root, "repo", "src");
	writeAgent(bundled, "worker", "bundled worker");
	writeAgent(join(agentDir, "agents"), "worker", "user worker", "tools: read, grep\nthinking: low\n");
	writeAgent(join(root, "repo", ".pi", "agents"), "worker", "project worker", "tools: none\n");
	mkdirSync(project, { recursive: true });

	const result = discoverAgents({
		cwd: project,
		scope: "both",
		projectTrusted: true,
		bundledDir: bundled,
		agentDir,
	});
	assert.equal(result.agents.length, 1);
	assert.equal(result.agents[0].source, "project");
	assert.equal(result.agents[0].description, "project worker");
	assert.deepEqual(result.agents[0].tools, []);
});

test("untrusted project agents are excluded with a diagnostic", () => {
	const root = tempRoot();
	const bundled = join(root, "bundled");
	const project = join(root, "repo");
	writeAgent(bundled, "scout", "bundled scout");
	writeAgent(join(project, ".pi", "agents"), "malicious", "project agent");

	const result = discoverAgents({
		cwd: project,
		scope: "both",
		projectTrusted: false,
		bundledDir: bundled,
		agentDir: join(root, "agent"),
	});
	assert.deepEqual(result.agents.map((agent) => agent.name), ["scout"]);
	assert.match(result.diagnostics.join("\n"), /not trusted/);
});

test("invalid files do not hide valid siblings", () => {
	const root = tempRoot();
	const bundled = join(root, "bundled");
	writeAgent(bundled, "valid", "valid agent");
	mkdirSync(bundled, { recursive: true });
	writeFileSync(join(bundled, "invalid.md"), "---\ndescription: missing name\n---\nbody\n");

	const result = discoverAgents({
		cwd: root,
		scope: "user",
		projectTrusted: false,
		bundledDir: bundled,
		agentDir: join(root, "agent"),
	});
	assert.deepEqual(result.agents.map((agent) => agent.name), ["valid"]);
	assert.match(result.diagnostics.join("\n"), /name must match/);
});

test("unsupported logical tool groups are rejected during discovery", () => {
	const root = tempRoot();
	const bundled = join(root, "bundled");
	writeAgent(bundled, "valid", "valid agent", "tools: read, $mutation\n");
	writeAgent(bundled, "invalid", "invalid agent", "tools: read, $unknown\n");

	const result = discoverAgents({
		cwd: root,
		scope: "user",
		projectTrusted: false,
		bundledDir: bundled,
		agentDir: join(root, "agent"),
	});
	assert.deepEqual(result.agents.map((agent) => agent.name), ["valid"]);
	assert.match(result.diagnostics.join("\n"), /unsupported logical tool "\$unknown"/);
});

test("managed runtime discovery uses materialized user agents without bundled fallback", () => {
	const root = tempRoot();
	const bundled = join(root, "bundled");
	const agentDir = join(root, "agent");
	writeAgent(bundled, "scout", "bundled scout");
	writeAgent(join(agentDir, "agents"), "scout", "materialized user scout");

	const result = discoverAgents({
		cwd: root,
		scope: "user",
		projectTrusted: false,
		bundledDir: bundled,
		agentDir,
		includeBundled: false,
	});
	assert.equal(result.agents.length, 1);
	assert.equal(result.agents[0].source, "user");
	assert.equal(result.agents[0].description, "materialized user scout");
});

test("direct bundled discovery does not require a user agent directory", () => {
	const root = tempRoot();
	const bundled = join(root, "bundled");
	const agentDir = join(root, "agent");
	writeAgent(bundled, "scout", "bundled scout");

	const result = discoverAgents({
		cwd: root,
		scope: "user",
		projectTrusted: false,
		bundledDir: bundled,
		agentDir,
		includeBundled: true,
	});
	assert.equal(result.agents.length, 1);
	assert.equal(result.agents[0].source, "bundled");
	assert.equal(existsSync(join(agentDir, "agents")), false);
});

test("unchanged legacy materialized presets do not shadow direct bundled updates", () => {
	const root = tempRoot();
	const bundled = join(root, "bundled");
	const agentDir = join(root, "agent");
	writeAgent(bundled, "scout", "bundled scout v2");
	writeAgent(join(agentDir, "agents"), "scout", "bundled scout v1");

	const result = discoverAgents({
		cwd: root,
		scope: "user",
		projectTrusted: false,
		bundledDir: bundled,
		agentDir,
		includeBundled: true,
		excludeUserAgentNames: new Set(["scout.md"]),
	});
	assert.equal(result.agents.length, 1);
	assert.equal(result.agents[0].source, "bundled");
	assert.equal(result.agents[0].description, "bundled scout v2");
});
