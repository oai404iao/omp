import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	FollowupTaskParameters,
	InterruptParameters,
	ListAgentsParameters,
	SendMessageParameters,
	WaitAgentParameters,
} from "../src/schemas.ts";
import { syncBundledAgents } from "../src/agent-sync.ts";

const root = mkdtempSync(join(tmpdir(), "pi-subagent-smoke-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");

after(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(root, { recursive: true, force: true });
});

function agentEnum(tool: { parameters: unknown } | undefined): unknown {
	const properties = (tool?.parameters as { properties?: Record<string, unknown> } | undefined)
		?.properties;
	return (properties?.agent as { enum?: unknown } | undefined)?.enum;
}

async function bindExtensionSession(cwd: string, agentDir: string) {
	const settingsManager = SettingsManager.inMemory({});
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		additionalExtensionPaths: [join(resolve(import.meta.dirname, ".."), "src", "index.ts")],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
	});
	const { session } = await createAgentSession({
		cwd,
		resourceLoader: loader,
		modelRuntime,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
	});
	await session.bindExtensions({ mode: "print" });
	return session;
}

test("extension loads and registers its model-facing surface", async () => {
	const cwd = resolve(import.meta.dirname, "..");
	const agentDir = join(root, "agent");
	const settingsManager = SettingsManager.inMemory({});
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		additionalExtensionPaths: [join(cwd, "src", "index.ts")],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);

	const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null });
	const { session } = await createAgentSession({
		cwd,
		resourceLoader: loader,
		modelRuntime,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
	});
	try {
		await session.bindExtensions({ mode: "print" });
		const names = new Set(session.getAllTools().map((tool) => tool.name));
		const active = new Set(session.getActiveToolNames());
		for (const expected of [
			"subagent",
			"subagent_fork",
			"send_message",
			"interrupt_agent",
			"list_agents",
		]) {
			assert.equal(names.has(expected), true, `${expected} should be registered`);
			assert.equal(active.has(expected), true, `${expected} should be active`);
		}
		assert.equal(names.has("followup_task"), true);
		assert.equal(
			active.has("followup_task"),
			true,
			"background mode should activate followup_task",
		);
		assert.equal(names.has("wait_agent"), true);
		assert.equal(
			active.has("wait_agent"),
			true,
			"background mode should activate wait_agent",
		);
		for (const toolName of ["subagent", "subagent_fork"]) {
			const tool = session.getAllTools().find((candidate) => candidate.name === toolName);
			assert.deepEqual(agentEnum(tool), ["planner", "reviewer", "scout", "worker"]);
		}
		for (const name of ["planner", "reviewer", "scout", "worker"]) {
			assert.equal(existsSync(join(agentDir, "agents", `${name}.md`)), true);
		}
		assert.equal(existsSync(join(agentDir, ".pi-subagent", "agents-manifest.json")), true);
	} finally {
		session.dispose();
	}
});

test("an empty effective catalog disables delegation tools", async () => {
	const extensionRoot = resolve(import.meta.dirname, "..");
	const cwd = join(root, "empty-project");
	const agentDir = join(root, "empty-agent");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(
		join(cwd, ".pi", "subagent.json"),
		JSON.stringify({ agentScope: "project" }),
	);
	const settingsManager = SettingsManager.inMemory({}, { projectTrusted: true });
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		additionalExtensionPaths: [join(extensionRoot, "src", "index.ts")],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);

	const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null });
	const { session } = await createAgentSession({
		cwd,
		resourceLoader: loader,
		modelRuntime,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
	});
	try {
		await session.bindExtensions({ mode: "print" });
		const active = new Set(session.getActiveToolNames());
		for (const toolName of ["subagent", "subagent_fork"]) {
			const tool = session.getAllTools().find((candidate) => candidate.name === toolName);
			assert.deepEqual(agentEnum(tool), []);
			assert.equal(active.has(toolName), false);
		}
	} finally {
		session.dispose();
	}
});

test("foreground-only empty catalog preserves SDK tool overrides", async () => {
	const extensionRoot = resolve(import.meta.dirname, "..");
	const cwd = join(root, "override-project");
	const agentDir = join(root, "override-agent");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(
		join(cwd, ".pi", "subagent.json"),
		JSON.stringify({
			agentScope: "project",
			runtimeMode: "foreground",
		}),
	);
	const parameters = {
		type: "object",
		properties: {
			agent: { type: "string", enum: ["override"] },
		},
		required: ["agent"],
		additionalProperties: false,
	} as const;
	const overrideParameters = new Map<string, object>([
		["subagent", parameters],
		["subagent_fork", parameters],
		["send_message", SendMessageParameters],
		["followup_task", FollowupTaskParameters],
		["wait_agent", WaitAgentParameters],
		["interrupt_agent", InterruptParameters],
		["list_agents", ListAgentsParameters],
	]);
	const customTools = [
		"subagent",
		"subagent_fork",
		"send_message",
		"followup_task",
		"wait_agent",
		"interrupt_agent",
		"list_agents",
	].map((name) => ({
		name,
		label: name,
		description: "override",
		parameters: overrideParameters.get(name)!,
		async execute() {
			return {
				content: [{ type: "text" as const, text: "override" }],
				details: {},
			};
		},
	}));
	const settingsManager = SettingsManager.inMemory({}, { projectTrusted: true });
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		additionalExtensionPaths: [join(extensionRoot, "src", "index.ts")],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);

	const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null });
	const { session } = await createAgentSession({
		cwd,
		resourceLoader: loader,
		modelRuntime,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
		customTools,
	});
	try {
		await session.bindExtensions({ mode: "print" });
		const active = new Set(session.getActiveToolNames());
		for (const toolName of [
			"subagent",
			"subagent_fork",
			"send_message",
			"followup_task",
			"wait_agent",
			"interrupt_agent",
			"list_agents",
		]) {
			const tool = session.getAllTools().find((candidate) => candidate.name === toolName);
			assert.ok(tool);
			assert.equal(tool.parameters, overrideParameters.get(toolName));
			assert.equal(active.has(toolName), true);
		}
	} finally {
		session.dispose();
	}
});

test("trusted foreground-only configuration hides background controls", async () => {
	const extensionRoot = resolve(import.meta.dirname, "..");
	const cwd = join(root, "foreground-project");
	const agentDir = join(root, "foreground-agent");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(
		join(cwd, ".pi", "subagent.json"),
		JSON.stringify({ runtimeMode: "foreground" }),
	);
	const settingsManager = SettingsManager.inMemory({}, { projectTrusted: true });
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		additionalExtensionPaths: [join(extensionRoot, "src", "index.ts")],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);

	const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null });
	const { session } = await createAgentSession({
		cwd,
		resourceLoader: loader,
		modelRuntime,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
	});
	try {
		await session.bindExtensions({ mode: "print" });
		const subagent = session.getAllTools().find((tool) => tool.name === "subagent");
		assert.ok(subagent);
		const properties = (subagent.parameters as { properties: Record<string, unknown> }).properties;
		assert.equal("run_in_background" in properties, false);
		const active = new Set(session.getActiveToolNames());
		assert.equal(active.has("subagent"), true);
		assert.equal(active.has("subagent_fork"), true);
		for (const toolName of [
			"send_message",
			"followup_task",
			"wait_agent",
			"interrupt_agent",
			"list_agents",
		]) {
			assert.equal(active.has(toolName), false);
		}
		for (const [toolName, args] of [
			[
				"send_message",
				{ subagent_id: "stale-child", message: "follow up" },
			],
			["followup_task", { subagent_id: "stale-child" }],
			["wait_agent", { timeout_ms: 0 }],
			["interrupt_agent", { agent_id: "stale-child" }],
			["list_agents", {}],
		] as const) {
			const tool = session.getToolDefinition(toolName);
			assert.ok(tool);
			await assert.rejects(
				() =>
					tool.execute(
						`stale-${toolName}`,
						args,
						undefined,
						undefined,
						{} as never,
					),
				/foreground-only mode/,
			);
		}
	} finally {
		session.dispose();
	}
});

test("the default background mode activates the durable mailbox controls", async () => {
	const extensionRoot = resolve(import.meta.dirname, "..");
	const cwd = join(root, "mailbox-project");
	const agentDir = join(root, "mailbox-agent");
	mkdirSync(cwd, { recursive: true });
	const settingsManager = SettingsManager.inMemory({}, { projectTrusted: true });
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		additionalExtensionPaths: [join(extensionRoot, "src", "index.ts")],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);

	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
	});
	const { session } = await createAgentSession({
		cwd,
		resourceLoader: loader,
		modelRuntime,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
	});
	try {
		await session.bindExtensions({ mode: "print" });
		assert.equal(session.getActiveToolNames().includes("followup_task"), true);
		assert.equal(session.getActiveToolNames().includes("wait_agent"), true);
	} finally {
		session.dispose();
	}
});

test("a corrupt initialization manifest does not block user roles", async () => {
	const cwd = resolve(import.meta.dirname, "..");
	const agentDir = join(root, "agent");
	rmSync(agentDir, { recursive: true, force: true });
	syncBundledAgents({
		bundledDir: join(cwd, "agents"),
		agentDir,
		packageRoot: cwd,
	});
	const manifestPath = join(agentDir, ".pi-subagent", "agents-manifest.json");
	const originalManifest = readFileSync(manifestPath);
	writeFileSync(manifestPath, "{broken");

	const session = await bindExtensionSession(cwd, agentDir);
	try {
		const active = new Set(session.getActiveToolNames());
		assert.equal(active.has("subagent"), true);
		assert.deepEqual(
			agentEnum(session.getAllTools().find((tool) => tool.name === "subagent")),
			["planner", "reviewer", "scout", "worker"],
		);
	} finally {
		session.dispose();
		writeFileSync(manifestPath, originalManifest);
	}
});

test("same-version deletion of every user role disables delegation", async () => {
	const cwd = resolve(import.meta.dirname, "..");
	const agentDir = join(root, "agent");
	rmSync(agentDir, { recursive: true, force: true });
	syncBundledAgents({
		bundledDir: join(cwd, "agents"),
		agentDir,
		packageRoot: cwd,
	});
	rmSync(join(agentDir, "agents"), { recursive: true, force: true });

	const session = await bindExtensionSession(cwd, agentDir);
	try {
		const active = new Set(session.getActiveToolNames());
		for (const toolName of ["subagent", "subagent_fork"]) {
			const tool = session.getAllTools().find((candidate) => candidate.name === toolName);
			assert.deepEqual(agentEnum(tool), []);
			assert.equal(active.has(toolName), false);
		}
		for (const name of ["planner", "reviewer", "scout", "worker"]) {
			assert.equal(existsSync(join(agentDir, "agents", `${name}.md`)), false);
		}
	} finally {
		session.dispose();
	}
});
