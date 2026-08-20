import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import externalThinking from "../src/index.js";

type ExtensionHandler = (event: any, ctx: any) => unknown;

class FakePi {
	readonly handlers: Record<string, ExtensionHandler[]> = {};
	readonly commands = new Map<string, any>();
	readonly flags = new Map<string, boolean | string | undefined>();
	readonly statuses = new Map<string, string | undefined>();
	readonly setActiveToolsCalls: string[][] = [];
	tool: any;
	thinkingLevel: any;
	activeTools: string[];
	toolAvailable: boolean;
	rejectOff: boolean;

	constructor({ activeTools = ["external_think"], thinkingLevel = "high", toolAvailable = true, rejectOff = false }: {
		activeTools?: string[];
		thinkingLevel?: string;
		toolAvailable?: boolean;
		rejectOff?: boolean;
	} = {}) {
		this.activeTools = [...activeTools];
		this.thinkingLevel = thinkingLevel;
		this.toolAvailable = toolAvailable;
		this.rejectOff = rejectOff;
	}

	on(event: string, handler: ExtensionHandler): void {
		(this.handlers[event] ??= []).push(handler);
	}

	registerTool(tool: any): void {
		this.tool = tool;
	}

	registerCommand(name: string, command: any): void {
		this.commands.set(name, command);
	}

	registerFlag(name: string, flag: { default?: boolean | string }): void {
		if (!this.flags.has(name)) this.flags.set(name, flag.default);
	}

	getFlag(name: string): boolean | string | undefined {
		return this.flags.get(name);
	}

	getActiveTools(): string[] {
		return [...this.activeTools];
	}

	getAllTools(): Array<{ name: string }> {
		return this.toolAvailable ? [{ name: "external_think" }] : [];
	}

	setActiveTools(names: string[]): void {
		this.activeTools = [...names];
		this.setActiveToolsCalls.push([...names]);
	}

	getThinkingLevel(): any {
		return this.thinkingLevel;
	}

	setThinkingLevel(level: any): void {
		if (level === "off" && this.rejectOff) return;
		this.thinkingLevel = level;
	}
}

function model(api = "openai-responses", overrides: Record<string, unknown> = {}): any {
	return {
		id: "test-model",
		name: "Test model",
		api,
		provider: "test-provider",
		baseUrl: "https://example.invalid/v1",
		reasoning: true,
		thinkingLevelMap: { off: "none" },
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
		...overrides,
	};
}

async function emit(pi: FakePi, event: string, ctx: any, payload: Record<string, unknown> = {}): Promise<unknown> {
	let result: unknown;
	for (const handler of pi.handlers[event] ?? []) result = await handler(payload, ctx);
	return result;
}

interface HarnessOptions {
	activeTools?: string[];
	thinkingLevel?: string;
	model?: any;
	flag?: boolean;
	state?: unknown;
	toolAvailable?: boolean;
	rejectOff?: boolean;
}

interface Harness {
	pi: FakePi;
	ctx: any;
	notifications: Array<{ message: string; level: string }>;
}

async function withHarness(options: HarnessOptions, run: (harness: Harness) => Promise<void>): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "pi-external-thinking-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	if (options.state !== undefined) {
		writeFileSync(join(agentDir, "external-thinking.json"), JSON.stringify(options.state));
	}

	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const pi = new FakePi(options);
		if (options.flag !== undefined) pi.flags.set("external-thinking", options.flag);
		const notifications: Array<{ message: string; level: string }> = [];
		const ctx = {
			hasUI: true,
			model: options.model ?? model(),
			ui: {
				notify(message: string, level: string) {
					notifications.push({ message, level });
				},
				setStatus(key: string, value: string | undefined) {
					pi.statuses.set(key, value);
				},
			},
		};
		externalThinking(pi as any);
		await run({ pi, ctx, notifications });
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	}
}

async function runCommand(pi: FakePi, input: string, ctx: any): Promise<void> {
	await pi.commands.get("external-thinking").handler(input, ctx);
}

test("registers a visible package-specific Think tool, command, flag, and lifecycle hooks", async () => {
	await withHarness({}, async ({ pi }) => {
		assert.equal(pi.tool.name, "external_think");
		assert.match(pi.tool.description, /visible/i);
		assert.doesNotMatch(pi.tool.description, /private|not shown/i);
		assert.match(pi.tool.parameters.properties.thoughts.description, /visible/i);
		assert.doesNotMatch(pi.tool.parameters.properties.thoughts.description, /private|not shown/i);
		assert.ok(pi.commands.has("external-thinking"));
		assert.equal(pi.flags.get("external-thinking"), false);
		for (const event of [
			"session_start",
			"model_select",
			"thinking_level_select",
			"before_agent_start",
			"before_provider_request",
		]) {
			assert.equal(pi.handlers[event]?.length, 1, `${event} must be registered`);
		}
	});
});

test("hard mode forces the package-specific Think tool for each supported provider payload", async () => {
	const cases: Array<{
		api: string;
		payload: Record<string, unknown>;
		expected: unknown;
	}> = [
		{
			api: "openai-responses",
			payload: { tools: [{ name: "think" }, { name: "external_think" }] },
			expected: { type: "function", name: "external_think" },
		},
		{
			api: "openai-completions",
			payload: { tools: [{ function: { name: "external_think" } }] },
			expected: { type: "function", function: { name: "external_think" } },
		},
		{
			api: "anthropic-messages",
			payload: { tools: [{ name: "external_think" }] },
			expected: { type: "tool", name: "external_think" },
		},
		{
			api: "google-generative-ai",
			payload: { config: { tools: [{ functionDeclarations: [{ name: "external_think" }] }] } },
			expected: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["external_think"] } },
		},
	];

	for (const { api, payload, expected } of cases) {
		await withHarness({ model: model(api) }, async ({ pi, ctx }) => {
			await runCommand(pi, "on hard", ctx);
			assert.equal(pi.getThinkingLevel(), "off");
			assert.match(pi.statuses.get("external-thinking") ?? "", /^⚡ ext-think on(?! \\(soft\\))/);

			await emit(pi, "before_agent_start", ctx);
			const result = await emit(pi, "before_provider_request", ctx, { payload });
			assert.equal(result, payload);
			if (api.startsWith("google")) {
				assert.deepEqual((payload.config as any).toolConfig, expected);
			} else {
				assert.deepEqual(payload.tool_choice, expected);
			}
		});
	}
});

test("soft mode leaves a provider payload untouched", async () => {
	await withHarness({}, async ({ pi, ctx }) => {
		const payload = { tools: [{ name: "external_think" }] };
		await runCommand(pi, "on soft", ctx);
		await emit(pi, "before_agent_start", ctx);
		const result = await emit(pi, "before_provider_request", ctx, { payload });

		assert.equal(result, undefined);
		assert.equal("tool_choice" in payload, false);
		assert.equal(pi.getThinkingLevel(), "off");
	});
});

test("refuses models that cannot disable native reasoning and does not bypass tool restrictions", async () => {
	await withHarness(
		{ model: model("openai-responses", { thinkingLevelMap: { off: null } }) },
		async ({ pi, ctx, notifications }) => {
			await runCommand(pi, "on hard", ctx);
			assert.equal(pi.getThinkingLevel(), "high");
			assert.match(notifications.at(-1)?.message ?? "", /cannot disable native reasoning/);
		},
	);

	await withHarness({ activeTools: [], toolAvailable: false }, async ({ pi, ctx, notifications }) => {
		await runCommand(pi, "on hard", ctx);
		assert.equal(pi.getThinkingLevel(), "high");
		assert.deepEqual(pi.setActiveToolsCalls, []);
		assert.match(notifications.at(-1)?.message ?? "", /excluded by --tools/);
	});
});

test("rejects the Codex protocol and models that do not apply off", async () => {
	await withHarness({ model: model("openai-codex-responses") }, async ({ pi, ctx, notifications }) => {
		await runCommand(pi, "on hard", ctx);
		assert.equal(pi.getThinkingLevel(), "high");
		assert.match(notifications.at(-1)?.message ?? "", /cannot be rewritten/);
	});

	await withHarness({ rejectOff: true }, async ({ pi, ctx, notifications }) => {
		await runCommand(pi, "on hard", ctx);
		assert.equal(pi.getThinkingLevel(), "high");
		assert.deepEqual(pi.getActiveTools(), []);
		assert.match(notifications.at(-1)?.message ?? "", /could not be activated/);
	});
});

test("re-enables the package-specific Think tool only after this extension disabled it", async () => {
	await withHarness({}, async ({ pi, ctx }) => {
		await emit(pi, "session_start", ctx);
		assert.deepEqual(pi.getActiveTools(), []);

		await runCommand(pi, "on hard", ctx);
		assert.deepEqual(pi.getActiveTools(), ["external_think"]);
		assert.equal(pi.getThinkingLevel(), "off");
	});
});

test("persisted startup and model changes fail closed, then resume when compatible", async () => {
	await withHarness(
		{
			model: model("openai-responses", { thinkingLevelMap: { off: null } }),
			state: { enabled: true, previousThinkingLevel: "medium", forceToolChoice: true },
		},
		async ({ pi, ctx, notifications }) => {
			await emit(pi, "session_start", ctx);
			assert.equal(pi.getThinkingLevel(), "high");
			assert.match(notifications.at(-1)?.message ?? "", /not enabled/);

			ctx.model = model();
			await emit(pi, "model_select", ctx);
			assert.equal(pi.getThinkingLevel(), "off");

			ctx.model = model("openai-responses", { thinkingLevelMap: { off: null } });
			await emit(pi, "model_select", ctx);
			assert.equal(pi.getThinkingLevel(), "medium");
			assert.match(notifications.at(-1)?.message ?? "", /paused/);

			ctx.model = model();
			await emit(pi, "model_select", ctx);
			assert.equal(pi.getThinkingLevel(), "off");
		},
	);
});

test("off clears persisted state after an incompatibility pause", async () => {
	await withHarness({}, async ({ pi, ctx }) => {
		await runCommand(pi, "on hard", ctx);
		assert.equal(pi.getThinkingLevel(), "off");

		ctx.model = model("openai-responses", { thinkingLevelMap: { off: null } });
		await emit(pi, "model_select", ctx);
		assert.equal(pi.getThinkingLevel(), "high");

		await runCommand(pi, "off", ctx);
		assert.deepEqual(pi.getActiveTools(), []);

		ctx.model = model();
		await emit(pi, "model_select", ctx);
		assert.equal(pi.getThinkingLevel(), "high");
		assert.deepEqual(pi.getActiveTools(), []);
	});
});

test("a hard-mode request without a writable think tool pauses the extension", async () => {
	await withHarness({}, async ({ pi, ctx, notifications }) => {
		await runCommand(pi, "on hard", ctx);
		await emit(pi, "before_agent_start", ctx);
		const payload = { tools: [] };
		const result = await emit(pi, "before_provider_request", ctx, { payload });

		assert.equal(result, payload);
		assert.equal(pi.getThinkingLevel(), "high");
		assert.match(notifications.at(-1)?.message ?? "", /paused/);
		assert.match(notifications.at(-1)?.message ?? "", /writable think tool definition/);
	});
});
