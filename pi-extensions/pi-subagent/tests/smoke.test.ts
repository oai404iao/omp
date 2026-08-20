import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
	InterruptParameters,
	ListAgentsParameters,
	SendMessageParameters,
} from "../src/schemas.ts";

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
		for (const toolName of ["subagent", "subagent_fork"]) {
			const tool = session.getAllTools().find((candidate) => candidate.name === toolName);
			assert.deepEqual(agentEnum(tool), ["planner", "reviewer", "scout", "worker"]);
		}
		assert.equal(existsSync(join(agentDir, "agents")), false);
		assert.equal(existsSync(join(agentDir, ".pi-subagent")), false);
	} finally {
		session.dispose();
	}
});

test("explicit syncBundledAgents opt-in materializes managed presets", async () => {
	const cwd = resolve(import.meta.dirname, "..");
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "subagent.json"), JSON.stringify({ syncBundledAgents: true }));
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
		assert.equal(existsSync(join(agentDir, "agents", "planner.md")), true);
		assert.equal(existsSync(join(agentDir, ".pi-subagent", "agents-manifest.json")), true);
	} finally {
		session.dispose();
		rmSync(join(agentDir, "agents"), { recursive: true, force: true });
		rmSync(join(agentDir, ".pi-subagent"), { recursive: true, force: true });
		rmSync(join(agentDir, "subagent.json"), { force: true });
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
			enableRunInBackground: false,
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
		["interrupt_agent", InterruptParameters],
		["list_agents", ListAgentsParameters],
	]);
	const customTools = [
		"subagent",
		"subagent_fork",
		"send_message",
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
		JSON.stringify({ enableRunInBackground: false }),
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
		for (const toolName of ["send_message", "interrupt_agent", "list_agents"]) {
			assert.equal(active.has(toolName), false);
		}
		for (const [toolName, args] of [
			[
				"send_message",
				{ subagent_id: "stale-child", message: "follow up" },
			],
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
