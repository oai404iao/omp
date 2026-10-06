import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import {
	createAssistantMessageEventStream,
	getCurrentTools,
	type AssistantMessage,
	type Context,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionToolContext,
	ModelRegistry,
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

function writeAgent(agentDir: string, name: string, description: string): void {
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	writeFileSync(
		join(agentDir, "agents", `${name}.md`),
		`---\nname: ${name}\ndescription: ${description}\ntools: read\n---\nPrivate child instructions.\n`,
	);
}

async function bindExtensionSession(cwd: string, agentDir: string, runtime?: ModelRuntime) {
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const settingsManager = SettingsManager.inMemory({});
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		additionalExtensionPaths: [join(resolve(import.meta.dirname, ".."), "index.ts")],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const modelRuntime = runtime ?? await ModelRuntime.create({
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
	await session.bindExtensions({
		mode: "print",
		onError: (error) => assert.fail(JSON.stringify(error)),
	});
	return session;
}

test("extension loads and registers its model-facing surface", async () => {
	const cwd = resolve(import.meta.dirname, "..");
	const agentDir = join(root, "agent");
	writeAgent(agentDir, "inspector", "Inspect user-selected files");
	writeAgent(agentDir, "reviewer", "Review user changes");
	const settingsManager = SettingsManager.inMemory({});
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		additionalExtensionPaths: [join(cwd, "index.ts")],
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
		for (const name of ["subagent", "subagent_fork", "send_message", "followup_task", "wait_agent", "interrupt_agent", "list_agents"]) {
			assert.equal(session.getToolDefinition(name)?.exposure, "model-only", name);
			assert.equal(session.getCallableToolNames().includes(name), false, name);
		}
		for (const toolName of ["subagent", "subagent_fork"]) {
			const tool = session.getAllTools().find((candidate) => candidate.name === toolName);
			assert.deepEqual(agentEnum(tool), ["inspector", "reviewer"]);
			assert.match(tool!.description, /Available agents:\n- inspector: Inspect user-selected files\n- reviewer: Review user changes/);
			assert.doesNotMatch(tool!.description, /Private child instructions/);
		}
		assert.deepEqual(readdirSync(join(agentDir, "agents")).sort(), ["inspector.md", "reviewer.md"]);
		assert.equal(existsSync(join(agentDir, ".pi-subagent")), false);
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
		additionalExtensionPaths: [join(extensionRoot, "index.ts")],
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
		additionalExtensionPaths: [join(extensionRoot, "index.ts")],
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
	process.env.PI_CODING_AGENT_DIR = agentDir;
	writeAgent(agentDir, "inspector", "Inspect files");
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
		additionalExtensionPaths: [join(extensionRoot, "index.ts")],
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
		additionalExtensionPaths: [join(extensionRoot, "index.ts")],
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

test("startup and reload leave old manifests, backups, and user definitions untouched", async () => {
	const cwd = resolve(import.meta.dirname, "..");
	const agentDir = join(root, "legacy-agent");
	writeAgent(agentDir, "scout", "User customization");
	const legacyDir = join(agentDir, ".pi-subagent");
	mkdirSync(join(legacyDir, "backups"), { recursive: true });
	const manifestPath = join(legacyDir, "agents-manifest.json");
	const backupPath = join(legacyDir, "backups", "scout.md");
	writeFileSync(backupPath, "Legacy backup");
	const agentPath = join(agentDir, "agents", "scout.md");
	const originalAgent = readFileSync(agentPath, "utf8");
	// Both a broken manifest and an old release's valid manifest are ignored.
	for (const manifest of [
		"{broken",
		JSON.stringify({ version: 1, packageVersion: "0.0.1", files: {}, retired: [] }),
	]) {
		writeFileSync(manifestPath, manifest);
		const session = await bindExtensionSession(cwd, agentDir);
		try {
			await session.reload();
			assert.equal(session.getActiveToolNames().includes("subagent"), true);
			assert.deepEqual(agentEnum(session.getToolDefinition("subagent")), ["scout"]);
			assert.equal(readFileSync(agentPath, "utf8"), originalAgent);
			assert.equal(readFileSync(manifestPath, "utf8"), manifest);
			assert.equal(readFileSync(backupPath, "utf8"), "Legacy backup");
			assert.deepEqual(readdirSync(legacyDir).sort(), ["agents-manifest.json", "backups"]);
			assert.deepEqual(readdirSync(join(agentDir, "agents")), ["scout.md"]);
		} finally {
			session.dispose();
		}
	}
});

test("reload refreshes catalog descriptions, enums, and empty-catalog activation", async () => {
	const cwd = resolve(import.meta.dirname, "..");
	const agentDir = join(root, "reload-agent");
	const session = await bindExtensionSession(cwd, agentDir);
	const assertCatalog = (names: string[], entries: string[]) => {
		for (const toolName of ["subagent", "subagent_fork"]) {
			const tool = session.getToolDefinition(toolName);
			assert.ok(tool);
			assert.deepEqual(agentEnum(tool), names);
			assert.equal(session.getActiveToolNames().includes(toolName), names.length > 0);
			assert.equal(
				tool.description.split("\n\nAvailable agents:\n")[1],
				entries.length ? entries.join("\n") : "(no agents)",
			);
		}
	};
	try {
		assertCatalog([], []);
		assert.equal(existsSync(join(agentDir, "agents")), false);
		assert.equal(existsSync(join(agentDir, ".pi-subagent")), false);
		writeAgent(agentDir, "scout", "First description");
		assertCatalog([], []);
		await session.reload();
		assertCatalog(["scout"], ["- scout: First description"]);

		writeAgent(agentDir, "scout", "Updated description");
		assertCatalog(["scout"], ["- scout: First description"]);
		await session.reload();
		assertCatalog(["scout"], ["- scout: Updated description"]);

		writeAgent(agentDir, "reviewer", "Review changes");
		rmSync(join(agentDir, "agents", "scout.md"));
		await session.reload();
		assertCatalog(["reviewer"], ["- reviewer: Review changes"]);

		writeFileSync(
			join(agentDir, "agents", "invalid.md"),
			"---\nname: invalid\n---\nMissing description.\n",
		);
		await session.reload();
		assertCatalog(["reviewer"], ["- reviewer: Review changes"]);

		rmSync(join(agentDir, "agents"), { recursive: true });
		await session.reload();
		assertCatalog([], []);
		assert.equal(existsSync(join(agentDir, "agents")), false);

		writeAgent(agentDir, "restored", "User restored role");
		await session.reload();
		assertCatalog(["restored"], ["- restored: User restored role"]);
	} finally {
		session.dispose();
	}
});

test("deleting every user role disables delegation across restarts", async () => {
	const cwd = resolve(import.meta.dirname, "..");
	const agentDir = join(root, "deleted-agent");
	writeAgent(agentDir, "scout", "User scout");
	const firstSession = await bindExtensionSession(cwd, agentDir);
	firstSession.dispose();
	rmSync(join(agentDir, "agents"), { recursive: true, force: true });

	const session = await bindExtensionSession(cwd, agentDir);
	try {
		const active = new Set(session.getActiveToolNames());
		for (const toolName of ["subagent", "subagent_fork"]) {
			const tool = session.getAllTools().find((candidate) => candidate.name === toolName);
			assert.deepEqual(agentEnum(tool), []);
			assert.equal(active.has(toolName), false);
		}
		assert.equal(existsSync(join(agentDir, "agents")), false);
		assert.equal(existsSync(join(agentDir, ".pi-subagent")), false);
	} finally {
		session.dispose();
	}
});

test("both delegation tools execute their published snapshot until reload", async () => {
	const cwd = resolve(import.meta.dirname, "..");
	const agentDir = join(root, "snapshot-agent");
	writeAgent(agentDir, "inspector", "Original definition");
	writeFileSync(join(agentDir, "subagent.json"), JSON.stringify({ runtimeMode: "foreground" }));
	const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null });
	const requests: Context[] = [];
	const registerProvider = () => runtime.registerProvider("snapshot-test", {
		baseUrl: "http://snapshot.invalid",
		apiKey: "test",
		api: "openai-responses",
		models: [{
			id: "echo", name: "Echo", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 10_000, maxTokens: 1000,
		}],
		streamSimple: (model, context) => {
			requests.push(structuredClone(context));
			const stream = createAssistantMessageEventStream();
			const message: AssistantMessage = {
				role: "assistant", content: [{ type: "text", text: "done" }],
				api: model.api, provider: model.provider, model: model.id,
				stopReason: "stop", timestamp: Date.now(),
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			};
			stream.push({ type: "done", reason: "stop", message });
			stream.end();
			return stream;
		},
	});
	registerProvider();
	const session = await bindExtensionSession(cwd, agentDir, runtime);
	const executeBoth = async (prompt: string, tools: string[]) => {
		for (const name of ["subagent", "subagent_fork"]) {
			const tool = session.getToolDefinition(name)!;
			await tool.execute(name, { agent: "inspector", description: "test snapshot", prompt: "Inspect." },
				undefined, undefined, {
					cwd,
					sessionManager: session.sessionManager,
					modelRegistry: new ModelRegistry(runtime),
					model: runtime.getModel("snapshot-test", "echo"),
					thinkingLevel: "off",
					isProjectTrusted: () => false,
				} as unknown as ExtensionToolContext);
			const request = requests.at(-1)!;
			assert.match(JSON.stringify(request.messages.filter((message) => message.role === "system")), new RegExp(prompt));
			assert.deepEqual(getCurrentTools(request.messages).map((tool) => tool.name), tools);
		}
	};
	try {
		// Description, policy and prompt edits are all invisible until reload.
		writeFileSync(join(agentDir, "agents", "inspector.md"),
			"---\nname: inspector\ndescription: Updated definition\ntools: none\n---\nUpdated private instructions.\n");
		await executeBoth("Private child instructions", ["read"]);
		await session.reload();
		registerProvider();
		await executeBoth("Updated private instructions", []);
		assert.equal(requests.length, 4);
	} finally {
		session.dispose();
	}
});
