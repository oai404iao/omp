import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type ToolCall,
} from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	ModelRegistry,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS } from "../src/config.ts";
import { SubagentCoordinator } from "../src/coordinator.ts";

const roots: string[] = [];

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-subagent-coordinator-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scriptedStream(
	model: Model<any>,
	text: string,
	signal?: AbortSignal,
	delayMs = 0,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const run = () => {
		const partial: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial });
		if (signal?.aborted) {
			const error = { ...partial, stopReason: "aborted" as const, errorMessage: "aborted" };
			stream.push({ type: "error", reason: "aborted", error });
			stream.end();
			return;
		}
		partial.content = [{ type: "text", text }];
		stream.push({ type: "text_start", contentIndex: 0, partial });
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial });
		stream.push({
			type: "done",
			reason: "stop",
			message: { ...partial, stopReason: "stop" },
		});
		stream.end();
	};
	if (delayMs > 0) {
		const timer = setTimeout(run, delayMs);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				run();
			},
			{ once: true },
		);
	} else {
		queueMicrotask(run);
	}
	return stream;
}

function reportThenAnswerStream(
	model: Model<any>,
	context: Context,
	turn: number,
): AssistantMessageEventStream {
	if (context.messages.some((message) => message.role === "toolResult")) {
		return scriptedStream(model, `child answer ${turn}`);
	}
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const toolCall: ToolCall = {
			type: "toolCall",
			id: `report-${turn}`,
			name: "report",
			arguments: { output: `finding ${turn}` },
		};
		const partial: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial });
		partial.content = [toolCall];
		stream.push({ type: "toolcall_start", contentIndex: 0, partial });
		stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
		stream.push({
			type: "done",
			reason: "toolUse",
			message: { ...partial, stopReason: "toolUse" },
		});
		stream.end();
	});
	return stream;
}

async function fixture(
	options: {
		delayMs?: number;
		reportFirst?: boolean;
		persistent?: boolean;
		childExtension?: string;
		onRequestTools?: (tools: string[]) => void;
		onRequestContext?: (context: Context) => void;
	} = {},
) {
	const root = tempRoot();
	const agentDir = join(root, "agent");
	if (options.childExtension) {
		const extensionsDir = join(agentDir, "extensions");
		mkdirSync(extensionsDir, { recursive: true });
		writeFileSync(join(extensionsDir, "model-tools.js"), options.childExtension);
	}
	const modelRuntime = await ModelRuntime.create({
		authPath: join(root, "auth.json"),
		modelsPath: null,
	});
	let turn = 0;
	modelRuntime.registerProvider("scripted", {
		baseUrl: "http://scripted.invalid",
		apiKey: "test",
		api: "openai-responses",
		models: [
			{
				id: "echo",
				name: "Echo",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 10_000,
				maxTokens: 1000,
			},
		],
		streamSimple: (model, context, streamOptions) => {
			const currentTurn = ++turn;
			options.onRequestContext?.(context);
			options.onRequestTools?.((context.tools ?? []).map((tool) => tool.name));
			return options.reportFirst
				? reportThenAnswerStream(model, context, currentTurn)
				: scriptedStream(model, `child answer ${currentTurn}`, streamOptions?.signal, options.delayMs);
		},
	});
	const model = modelRuntime.getModel("scripted", "echo");
	assert.ok(model);
	const sessionManager =
		options.persistent === false
			? SessionManager.inMemory(root)
			: SessionManager.create(root, join(root, "sessions"));
	sessionManager.appendModelChange(model.provider, model.id);
	sessionManager.appendThinkingLevelChange("off");
	const messages: Array<{ content: string }> = [];
	const events: string[] = [];
	const pi = {
		events: { emit: (name: string) => events.push(name) },
		sendMessage: (message: { content: string }) => messages.push(message),
	} as unknown as ExtensionAPI;
	const coordinator = new SubagentCoordinator(
		pi,
		resolve(import.meta.dirname, "..", "agents"),
		resolve(import.meta.dirname, ".."),
		agentDir,
	);
	const context = {
		cwd: root,
		sessionManager,
		modelRegistry: new ModelRegistry(modelRuntime),
		model,
		thinkingLevel: "off",
		isProjectTrusted: () => true,
		isIdle: () => true,
	} as unknown as ExtensionContext;
	const parent = await coordinator.parentFromContext(context);
	return { coordinator, parent, messages, events, agentDir };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("condition timed out");
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
	}
}

test("one-shot child returns only its own final output and usage", async () => {
	const { coordinator, parent, events } = await fixture();
	try {
		const outcome = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "inspect module",
				prompt: "Inspect it.",
				run_in_background: false,
			},
			{ ...DEFAULT_SETTINGS, defaultBackground: false },
		);
		assert.equal(outcome.kind, "foreground");
		if (outcome.kind === "foreground") {
			assert.equal(outcome.result.output, "child answer 1");
			assert.equal(outcome.result.stopReason, "completed");
			assert.equal(outcome.result.usage.turns, 1);
		}
		assert.deepEqual(events, ["pi-subagent:start", "pi-subagent:end"]);
	} finally {
		await coordinator.shutdown();
	}
});

test("synchronized runtime settings materialize presets before discovery", async () => {
	const { coordinator, parent, agentDir } = await fixture();
	try {
		assert.equal(existsSync(join(agentDir, "agents")), false);
		const outcome = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "synchronized scout",
				prompt: "Inspect it.",
				run_in_background: false,
			},
			{ ...DEFAULT_SETTINGS, syncBundledAgents: true, defaultBackground: false },
		);
		assert.equal(outcome.kind, "foreground");
		assert.equal(existsSync(join(agentDir, "agents", "scout.md")), true);
	} finally {
		await coordinator.shutdown();
	}
});

test("continuable child settles, becomes ready, and cold-resumes for a later message", async () => {
	const { coordinator, parent, messages, events } = await fixture();
	try {
		const outcome = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "background scout",
				prompt: "Inspect it.",
				run_in_background: true,
			},
			{ ...DEFAULT_SETTINGS, defaultBackground: true },
		);
		assert.equal(outcome.kind, "continuable");
		await waitUntil(() => messages.length === 1);
		const id = outcome.details.id;
		const firstList = await coordinator.list(parent, "children");
		assert.equal(firstList[0]?.kind, "child");
		if (firstList[0]?.kind === "child") assert.equal(firstList[0].status, "ready");

		await coordinator.sendMessage(parent, id, "Inspect one more thing.");
		await waitUntil(() => messages.length === 2);
		assert.match(messages[0].content, /child answer 1/);
		assert.match(messages[1].content, /child answer 2/);
		assert.deepEqual(events, [
			"pi-subagent:start",
			"pi-subagent:end",
			"pi-subagent:start",
			"pi-subagent:end",
		]);
	} finally {
		await coordinator.shutdown();
	}
});

test("interrupt stops only the live activation and preserves its resumable session", async () => {
	const { coordinator, parent, messages } = await fixture({ delayMs: 100 });
	try {
		const outcome = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "interruptible scout",
				prompt: "Keep working.",
				run_in_background: true,
			},
			{ ...DEFAULT_SETTINGS, defaultBackground: true },
		);
		assert.equal(outcome.kind, "continuable");
		await coordinator.interrupt(parent, outcome.details.id);
		await waitUntil(() => messages.length === 1);
		assert.match(messages[0].content, /was interrupted/);
		const entries = await coordinator.list(parent, "children");
		assert.equal(entries[0]?.kind, "child");
		if (entries[0]?.kind === "child") assert.equal(entries[0].status, "ready");
	} finally {
		await coordinator.shutdown();
	}
});

test("continuable child can explicitly report before its independent settlement notice", async () => {
	const { coordinator, parent, messages } = await fixture({ reportFirst: true });
	try {
		await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "reporting scout",
				prompt: "Report a finding.",
				run_in_background: true,
			},
			{ ...DEFAULT_SETTINGS, defaultBackground: true },
		);
		await waitUntil(() => messages.length === 2);
		assert.match(messages[0].content, /reported:[\s\S]*finding 1/);
		assert.match(messages[1].content, /closing message:[\s\S]*child answer 2/);
	} finally {
		await coordinator.shutdown();
	}
});

test("continuable mode fails loud for an ephemeral parent", async () => {
	const { coordinator, parent } = await fixture({ persistent: false });
	try {
		await assert.rejects(
			() =>
				coordinator.delegate(
					parent,
					"spawn",
					{
						agent: "scout",
						description: "ephemeral child",
						prompt: "Inspect it.",
						run_in_background: true,
					},
					{ ...DEFAULT_SETTINGS, defaultBackground: true },
				),
			/require a persisted parent session/,
		);
	} finally {
		await coordinator.shutdown();
	}
});

test("foreground-only mode ignores the background default and waits for the result", async () => {
	const { coordinator, parent, events } = await fixture();
	try {
		const outcome = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "foreground scout",
				prompt: "Inspect it.",
			},
			{
				...DEFAULT_SETTINGS,
				enableRunInBackground: false,
				defaultBackground: true,
			},
		);
		assert.equal(outcome.kind, "foreground");
		if (outcome.kind === "foreground") assert.equal(outcome.result.output, "child answer 1");
		assert.deepEqual(events, ["pi-subagent:start", "pi-subagent:end"]);
	} finally {
		await coordinator.shutdown();
	}
});

test("foreground-only mode rejects a forced background call before starting a child", async () => {
	const { coordinator, parent, events } = await fixture();
	try {
		await assert.rejects(
			() =>
				coordinator.delegate(
					parent,
					"spawn",
					{
						agent: "scout",
						description: "forbidden background scout",
						prompt: "Inspect it.",
						run_in_background: true,
					},
					{
						...DEFAULT_SETTINGS,
						enableRunInBackground: false,
					},
				),
			/foreground-only mode/,
		);
		assert.deepEqual(events, []);
	} finally {
		await coordinator.shutdown();
	}
});

test("foreground-only children hide background lifecycle controls", async () => {
	const observedTools: string[][] = [];
	const { coordinator, parent } = await fixture({
		onRequestTools: (tools) => observedTools.push(tools),
	});
	try {
		const outcome = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "worker",
				description: "inspect foreground tools",
				prompt: "Inspect it.",
			},
			{
				...DEFAULT_SETTINGS,
				enableRunInBackground: false,
			},
		);
		assert.equal(outcome.kind, "foreground");
		assert.equal(observedTools.length, 1);
		assert.ok(observedTools[0].includes("subagent"));
		assert.ok(observedTools[0].includes("subagent_fork"));
		for (const tool of ["send_message", "interrupt_agent", "list_agents"]) {
			assert.ok(!observedTools[0].includes(tool));
		}
		const staleDefinitions = coordinator.createChildToolDefinitions(
			() => {
				throw new Error("activation should not be read");
			},
			false,
		);
		for (const [toolName, args] of [
			[
				"send_message",
				{ subagent_id: "stale-child", message: "follow up" },
			],
			["interrupt_agent", { agent_id: "stale-child" }],
			["list_agents", {}],
		] as const) {
			const tool = staleDefinitions.find((candidate) => candidate.name === toolName);
			assert.ok(tool);
			await assert.rejects(
				() =>
					tool.execute(
						`stale-${toolName}`,
						args,
						undefined,
						undefined,
						{} as ExtensionContext,
					),
				/foreground-only mode/,
			);
		}
	} finally {
		await coordinator.shutdown();
	}
});

test("nested delegation tools enumerate the available agent definitions", async () => {
	const observed = new Map<string, unknown>();
	const { coordinator, parent } = await fixture({
		onRequestContext: (context) => {
			for (const name of ["subagent", "subagent_fork"]) {
				const tool = context.tools?.find((candidate) => candidate.name === name);
				const properties = (
					tool?.parameters as { properties?: Record<string, unknown> } | undefined
				)?.properties;
				observed.set(
					name,
					(properties?.agent as { enum?: unknown } | undefined)?.enum,
				);
			}
		},
	});
	try {
		await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "worker",
				description: "inspect nested schema",
				prompt: "Inspect it.",
				run_in_background: false,
			},
			{ ...DEFAULT_SETTINGS, defaultBackground: false },
		);
		for (const name of ["subagent", "subagent_fork"]) {
			assert.deepEqual(observed.get(name), ["planner", "reviewer", "scout", "worker"]);
		}
	} finally {
		await coordinator.shutdown();
	}
});

test("worker mutation policy falls back to Pi edit and write tools", async () => {
	const observedTools: string[][] = [];
	const { coordinator, parent } = await fixture({
		onRequestTools: (tools) => observedTools.push(tools),
	});
	try {
		const outcome = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "worker",
				description: "apply a focused change",
				prompt: "Make the change.",
				run_in_background: false,
			},
			{ ...DEFAULT_SETTINGS, defaultBackground: false },
		);
		assert.equal(outcome.kind, "foreground");
		assert.equal(observedTools.length, 1);
		assert.ok(observedTools[0].includes("edit"));
		assert.ok(observedTools[0].includes("write"));
		assert.ok(!observedTools[0].includes("apply_patch"));
		assert.ok(!observedTools[0].includes("$mutation"));
	} finally {
		await coordinator.shutdown();
	}
});

test("worker mutation policy composes with an extension-selected apply_patch", async () => {
	const observedTools: string[][] = [];
	const childExtension = `
export default function modelTools(pi) {
	const parameters = {
		type: "object",
		properties: {},
		additionalProperties: false,
	};
	pi.on("session_start", async () => {
		for (const name of ["apply_patch", "dangerous"]) {
			pi.registerTool({
				name,
				label: name,
				description: name,
				parameters,
				async execute() {
					return { content: [{ type: "text", text: "ok" }] };
				},
			});
		}
		const active = pi.getActiveTools();
		pi.setActiveTools([
			...active.filter((name) => name !== "edit" && name !== "write"),
			"apply_patch",
			"dangerous",
		]);
	});
}
`;
	const { coordinator, parent } = await fixture({
		childExtension,
		onRequestTools: (tools) => observedTools.push(tools),
	});
	try {
		const outcome = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "worker",
				description: "apply a focused change",
				prompt: "Make the change.",
				run_in_background: false,
			},
			{
				...DEFAULT_SETTINGS,
				defaultBackground: false,
				inheritExtensions: true,
			},
		);
		assert.equal(outcome.kind, "foreground");
		assert.equal(observedTools.length, 1);
		assert.ok(observedTools[0].includes("apply_patch"));
		assert.ok(!observedTools[0].includes("edit"));
		assert.ok(!observedTools[0].includes("write"));
		assert.ok(!observedTools[0].includes("dangerous"));
		assert.ok(!observedTools[0].includes("$mutation"));
	} finally {
		await coordinator.shutdown();
	}
});
