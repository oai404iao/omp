import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test, type TestContext } from "node:test";
import {
	createAssistantMessageEventStream,
	getCurrentTools,
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
import { CODEX_IDENTITY_CUSTOM_TYPE } from "@oai404iao/pi-codex-minimal-tools/subagent-inline";
import { DEFAULT_SETTINGS } from "../src/config.ts";
import {
	COMPLETION_FAILURE_CUSTOM_TYPE,
	COMPLETION_UPDATE_CUSTOM_TYPE,
	readCompletionMailbox,
	type CompletionUpdate,
} from "../src/completion-mailbox.ts";
import { SubagentCoordinator, AGENT_CUSTOM_TYPE } from "../src/coordinator.ts";
import {
	DESCRIPTOR_CUSTOM_TYPE,
	foldDescriptor,
} from "../src/descriptor.ts";
import {
	MAILBOX_CLAIM_CUSTOM_TYPE,
	MAILBOX_COMMIT_CUSTOM_TYPE,
	readMailbox,
} from "../src/mailbox.ts";
import { withTargetResolutionOrder } from "./support/target-resolution-order.ts";

const roots: string[] = [];
const UUID_V7_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
	onStart?: () => void,
	onEnd?: () => void,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	onStart?.();
	let ended = false;
	const finish = () => {
		if (ended) return;
		ended = true;
		onEnd?.();
	};
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
			finish();
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
		finish();
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

function toolCallStream(
	model: Model<any>,
	toolCall: ToolCall,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
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
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
				},
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial });
		partial.content = [toolCall];
		stream.push({ type: "toolcall_start", contentIndex: 0, partial });
		stream.push({
			type: "toolcall_end",
			contentIndex: 0,
			toolCall,
			partial,
		});
		stream.push({
			type: "done",
			reason: "toolUse",
			message: { ...partial, stopReason: "toolUse" },
		});
		stream.end();
	});
	return stream;
}

function appendCompletedParentTurn(
	session: SessionManager,
	userText: string,
	assistantText: string,
): void {
	session.appendMessage({
		role: "user",
		content: userText,
		timestamp: Date.now(),
	});
	session.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: assistantText }],
		api: "openai-responses",
		provider: "scripted",
		model: "echo",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
}

function userMessageText(
	message: Extract<Context["messages"][number], { role: "user" }>,
): string {
	return typeof message.content === "string"
		? message.content
		: message.content
				.filter(
					(item): item is Extract<
						(typeof message.content)[number],
						{ type: "text" }
					> => item.type === "text",
				)
				.map((item) => item.text)
				.join("");
}

async function fixture(
	options: {
		delayMs?: number;
		reportFirst?: boolean;
		persistent?: boolean;
		childExtension?: string;
		onRequestTools?: (tools: string[]) => void;
		onRequestContext?: (context: Context) => void;
		onStreamStart?: () => void;
		onStreamEnd?: () => void;
		streamSimple?: (
			model: Model<any>,
			context: Context,
			turn: number,
			signal: AbortSignal | undefined,
		) => AssistantMessageEventStream;
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
			options.onRequestTools?.(getCurrentTools(context.messages).map((tool) => tool.name));
			if (options.streamSimple) {
				return options.streamSimple(
					model,
					context,
					currentTurn,
					streamOptions?.signal,
				);
			}
			return options.reportFirst
				? reportThenAnswerStream(model, context, currentTurn)
				: scriptedStream(
						model,
						`child answer ${currentTurn}`,
						streamOptions?.signal,
						options.delayMs,
						options.onStreamStart,
						options.onStreamEnd,
					);
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
	const eventDetails: Array<{ name: string; data: unknown }> = [];
	const pi = {
		events: {
			emit: (name: string, data: unknown) => {
				if (name === "pi-subagent:start" || name === "pi-subagent:end") {
					events.push(name);
				}
				eventDetails.push({ name, data });
			},
		},
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
	return {
		coordinator,
		parent,
		messages,
		events,
		eventDetails,
		agentDir,
		pi,
		context,
		modelRuntime,
		model,
	};
}

async function waitUntil(
	predicate: () => boolean | Promise<boolean>,
	timeoutMs = 2000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		if (Date.now() >= deadline) throw new Error("condition timed out");
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
	}
}

async function waitForChildReady(
	coordinator: SubagentCoordinator,
	parent: Parameters<SubagentCoordinator["list"]>[0],
	agentId: string,
): Promise<void> {
	await waitUntil(async () => {
		const entries = await coordinator.list(parent, "children");
		return entries.some(
			(entry) =>
				entry.kind === "child"
				&& entry.agentId === agentId
				&& entry.status === "ready",
		);
	});
}

async function waitForChildStatus(
	coordinator: SubagentCoordinator,
	parent: Parameters<SubagentCoordinator["list"]>[0],
	agentId: string,
	status: "running" | "idle" | "ready",
): Promise<void> {
	await waitUntil(async () => {
		const entries = await coordinator.list(parent, "children");
		return entries.some(
			(entry) =>
				entry.kind === "child"
				&& entry.agentId === agentId
				&& entry.status === status,
		);
	});
}

function parentCompletions(
	parent: Parameters<SubagentCoordinator["list"]>[0],
): CompletionUpdate[] {
	return readCompletionMailbox(
		(parent.sessionManager as SessionManager).getEntries(),
		{ parentAgentId: parent.agentId },
	).updates;
}

async function waitForCompletions(
	parent: Parameters<SubagentCoordinator["list"]>[0],
	count: number,
): Promise<void> {
	await waitUntil(() => parentCompletions(parent).length >= count);
}

function appendWaitAgentToolResult(
	parent: Parameters<SubagentCoordinator["list"]>[0],
	toolCallId: string,
): void {
	(parent.sessionManager as SessionManager).appendMessage({
		role: "toolResult",
		toolCallId,
		toolName: "wait_agent",
		content: [{ type: "text", text: "completion delivered" }],
		isError: false,
		timestamp: Date.now(),
	});
}

test("one-shot child returns only its own final output and usage", async () => {
	const { coordinator, parent, events, eventDetails } = await fixture();
	try {
		const outcome = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "inspect module",
				prompt: "Inspect it.",
			},
			{ ...DEFAULT_SETTINGS, runtimeMode: "foreground" as const },
		);
		assert.equal(outcome.kind, "foreground");
		if (outcome.kind === "foreground") {
			assert.equal(outcome.result.output, "child answer 1");
			assert.equal(outcome.result.stopReason, "completed");
			assert.equal(outcome.result.usage.turns, 1);
			assert.match(outcome.result.turnId, UUID_V7_PATTERN);
			assert.equal(outcome.details.turnId, outcome.result.turnId);
		}
		assert.deepEqual(events, ["pi-subagent:start", "pi-subagent:end"]);
		assert.deepEqual(
			eventDetails.map((event) => ({
				name: event.name,
				turnId: (event.data as { turnId?: string }).turnId,
			})),
			[
				{
					name: "pi-subagent:turn-start",
					turnId: outcome.details.turnId,
				},
				{ name: "pi-subagent:start", turnId: undefined },
				{
					name: "pi-subagent:turn-end",
					turnId: outcome.details.turnId,
				},
				{ name: "pi-subagent:end", turnId: undefined },
			],
		);
	} finally {
		await coordinator.shutdown();
	}
});

test("delegation assigns stable readable paths and disambiguates generated siblings", async () => {
	const { coordinator, parent } = await fixture();
	try {
		const first = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				task_name: "auth",
				description: "inspect auth",
				prompt: "Inspect auth.",
			},
			DEFAULT_SETTINGS,
		);
		assert.equal(first.kind, "continuable");
		if (first.kind !== "continuable") return;
		assert.equal(first.details.taskPath, "/root/auth");
		await waitForChildReady(coordinator, parent, first.details.agentId);

		await assert.rejects(
			() =>
				coordinator.delegate(
					parent,
					"spawn",
					{
						agent: "scout",
						task_name: "auth",
						description: "duplicate auth",
						prompt: "Inspect again.",
					},
					DEFAULT_SETTINGS,
				),
			/task path \/root\/auth is already in use/,
		);

		const generatedOne = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "inspect cache",
				prompt: "Inspect cache.",
			},
			DEFAULT_SETTINGS,
		);
		const generatedTwo = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "inspect cache",
				prompt: "Inspect cache again.",
			},
			DEFAULT_SETTINGS,
		);
		assert.equal(generatedOne.details.taskPath, "/root/inspect-cache");
		assert.equal(generatedTwo.details.taskPath, "/root/inspect-cache-2");
		const listed = await coordinator.list(parent, "children");
		assert.equal(
			listed.some(
				(entry) =>
					entry.kind === "child"
					&& entry.taskPath === "/root/auth"
					&& entry.agentId === first.details.agentId,
			),
			true,
		);
	} finally {
		await coordinator.shutdown();
	}
});

test("absolute and relative task paths resolve to the same serialized child", async () => {
	const { coordinator, parent } = await fixture();
	try {
		const outcome = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				task_name: "reader",
				description: "read target",
				prompt: "Initial read.",
			},
			DEFAULT_SETTINGS,
		);
		assert.equal(outcome.kind, "continuable");
		if (outcome.kind !== "continuable") return;
		await waitForChildReady(coordinator, parent, outcome.details.agentId);

		const relativeDelivery = await coordinator.sendMessageWithOutcome(
			parent,
			"reader",
			"Read again.",
		);
		assert.equal(relativeDelivery.agentId, outcome.details.agentId);
		assert.equal(relativeDelivery.taskPath, "/root/reader");
		await waitForChildReady(coordinator, parent, outcome.details.agentId);

		const absoluteDelivery = await coordinator.sendMessageWithOutcome(
			parent,
			"/root/reader",
			"Read once more.",
		);
		assert.equal(absoluteDelivery.agentId, outcome.details.agentId);
		assert.equal(absoluteDelivery.taskPath, "/root/reader");
		await waitForChildReady(coordinator, parent, outcome.details.agentId);
	} finally {
		await coordinator.shutdown();
	}
});

test("a nested parent resolves a direct child by its relative path", async () => {
	let scoutTurns = 0;
	const { coordinator, parent } = await fixture({
		streamSimple: (model, context, turn, signal) => {
			const canDelegate = getCurrentTools(context.messages).some(
				(tool) => tool.name === "subagent",
			);
			if (!canDelegate) {
				scoutTurns++;
				return scriptedStream(
					model,
					`nested scout turn ${scoutTurns}`,
					signal,
				);
			}
			const toolResults = context.messages.filter(
				(message) => message.role === "toolResult",
			);
			const latest = toolResults.at(-1);
			if (!latest) {
				return toolCallStream(model, {
					type: "toolCall",
					id: `spawn-leaf-${turn}`,
					name: "subagent",
					arguments: {
						agent: "scout",
						task_name: "leaf",
						description: "nested leaf",
						prompt: "Complete the first leaf turn.",
					},
				});
			}
			if (latest.toolName === "subagent") {
				return toolCallStream(model, {
					type: "toolCall",
					id: `message-leaf-${turn}`,
					name: "send_message",
					arguments: {
						subagent_id: "leaf",
						message: "Complete a relative-address follow-up.",
					},
				});
			}
			if (latest.toolName === "send_message") {
				return toolCallStream(model, {
					type: "toolCall",
					id: `followup-leaf-${turn}`,
					name: "followup_task",
					arguments: { subagent_id: "./leaf" },
				});
			}
			return scriptedStream(model, "nested parent done", signal);
		},
	});
	try {
		const outcome = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "worker",
				task_name: "parent",
				description: "nested parent",
				prompt: "Spawn leaf and send a relative follow-up.",
			},
			DEFAULT_SETTINGS,
		);
		assert.equal(outcome.kind, "continuable");
		if (outcome.kind !== "continuable") return;
		await waitForChildReady(coordinator, parent, outcome.details.agentId);
		const descendants = await coordinator.list(parent, "descendants");
		const leaf = descendants.find(
			(entry) =>
				entry.kind === "child"
				&& entry.taskPath === "/root/parent/leaf",
		);
		assert.equal(leaf?.kind, "child");
		assert.equal(scoutTurns, 2);
	} finally {
		await coordinator.shutdown();
	}
});

test("an unrelated cyclic descriptor component cannot block readable path operations", async () => {
	const { coordinator, parent } = await fixture();
	try {
		const seed = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				task_name: "seed",
				description: "seed child",
				prompt: "Create a descriptor seed.",
			},
			DEFAULT_SETTINGS,
		);
		assert.equal(seed.kind, "continuable");
		if (seed.kind !== "continuable") return;
		await waitForChildReady(coordinator, parent, seed.details.agentId);
		const seedEntry = (await coordinator.list(parent, "children")).find(
			(entry) =>
				entry.kind === "child"
				&& entry.agentId === seed.details.agentId,
		);
		assert.equal(seedEntry?.kind, "child");
		if (seedEntry?.kind !== "child" || !seedEntry.sessionFile) return;
		const seedManager = SessionManager.open(
			seedEntry.sessionFile,
			parent.sessionManager.getSessionDir(),
			parent.cwd,
		);
		const folded = foldDescriptor(seedManager.getEntries());
		assert.equal(folded.kind, "valid");
		if (folded.kind !== "valid") return;
		const rootFile = parent.sessionManager.getSessionFile();
		assert.ok(rootFile);
		const cycleIds = [
			"01900000-0000-7000-8000-0000000000a1",
			"01900000-0000-7000-8000-0000000000b2",
		] as const;
		for (let index = 0; index < cycleIds.length; index++) {
			const manager = SessionManager.create(
				parent.cwd,
				parent.sessionManager.getSessionDir(),
				{ parentSession: rootFile },
			);
			manager.appendCustomEntry(DESCRIPTOR_CUSTOM_TYPE, {
				...structuredClone(folded.descriptor),
				agentId: cycleIds[index],
				parentAgentId: cycleIds[1 - index],
				parentSessionFile: rootFile,
				task: {
					name: `cycle-${index + 1}`,
					path: `/root/cycle-${index + 1}`,
				},
			});
			appendCompletedParentTurn(
				manager,
				"persist cycle fixture",
				"cycle fixture persisted",
			);
		}
		let longParentPath = "/root";
		const targetLength = 4092;
		const suffix = "/parent";
		while (
			longParentPath.length + 65 + suffix.length
			<= targetLength
		) {
			longParentPath += `/${"x".repeat(64)}`;
		}
		const remaining =
			targetLength - longParentPath.length - suffix.length;
		if (remaining >= 2) {
			longParentPath += `/${"x".repeat(remaining - 1)}`;
		}
		longParentPath += suffix;
		const topologyIds = [
			"01900000-0000-7000-8000-0000000000c3",
			"01900000-0000-7000-8000-0000000000d4",
		] as const;
		for (let index = 0; index < topologyIds.length; index++) {
			const manager = SessionManager.create(
				parent.cwd,
				parent.sessionManager.getSessionDir(),
				{ parentSession: rootFile },
			);
			manager.appendCustomEntry(DESCRIPTOR_CUSTOM_TYPE, {
				...structuredClone(folded.descriptor),
				agentId: topologyIds[index],
				parentAgentId:
					index === 0 ? parent.agentId : topologyIds[0],
				parentSessionFile: rootFile,
				depth: index + 1,
				task:
					index === 0
						? {
								name: "parent",
								path: longParentPath,
							}
						: {
								name: "child",
								path: "/root/child",
							},
			});
			appendCompletedParentTurn(
				manager,
				"persist topology fixture",
				"topology fixture persisted",
			);
		}
		const withCycle = await coordinator.list(parent, "descendants");
		assert.equal(
			withCycle.filter(
				(entry) =>
					entry.kind === "diagnostic"
					&& /lineage contains a cycle/.test(entry.message),
			).length,
			2,
		);
		assert.equal(
			withCycle.some(
				(entry) =>
					entry.kind === "diagnostic"
					&& /cannot be joined/.test(entry.message),
			),
			true,
		);

		const delivery = await coordinator.sendMessageWithOutcome(
			parent,
			"/root/seed",
			"Path lookup still works.",
		);
		assert.equal(delivery.agentId, seed.details.agentId);
		await waitForChildReady(coordinator, parent, seed.details.agentId);
		const afterCycle = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				task_name: "after-cycle",
				description: "after cycle",
				prompt: "Create after corrupt topology.",
			},
			DEFAULT_SETTINGS,
		);
		assert.equal(afterCycle.details.taskPath, "/root/after-cycle");
	} finally {
		await coordinator.shutdown();
	}
});

test("last_n_completed context excludes the active parent tool turn", async () => {
	const requestContexts: Context[] = [];
	const { coordinator, parent } = await fixture({
		onRequestContext: (context) => requestContexts.push(context),
	});
	try {
		const manager = parent.sessionManager as SessionManager;
		appendCompletedParentTurn(manager, "question one", "answer one");
		appendCompletedParentTurn(manager, "question two", "answer two");
		appendCompletedParentTurn(manager, "question three", "answer three");
		manager.appendMessage({
			role: "user",
			content: "active parent turn",
			timestamp: Date.now(),
		});
		manager.appendMessage({
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "active-delegation",
					name: "subagent",
					arguments: {},
				},
			],
			api: "openai-responses",
			provider: "scripted",
			model: "echo",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
				},
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		});

		const outcome = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				task_name: "context-reader",
				description: "read context",
				prompt: "Use inherited context.",
				context: {
					mode: "last_n_completed",
					completed_turns: 2,
				},
			},
			{ ...DEFAULT_SETTINGS, runtimeMode: "foreground" as const },
		);
		assert.equal(outcome.kind, "foreground");
		assert.equal(outcome.details.provider, "fork");
		assert.equal(outcome.details.taskPath, "/root/context-reader");
		const request = requestContexts[0];
		assert.ok(request);
		const userTexts = request.messages
			.filter(
				(
					message,
				): message is Extract<
					Context["messages"][number],
					{ role: "user" }
				> => message.role === "user",
			)
			.map(userMessageText);
		assert.deepEqual(userTexts, [
			"question two",
			"question three",
			"Use inherited context.",
		]);
		assert.equal(
			request.messages.some(
				(message) =>
					message.role === "user"
					&& message.content === "active parent turn",
			),
			false,
		);
	} finally {
		await coordinator.shutdown();
	}
});

test("subagent_fork can create a continuable inherited-context child", async () => {
	const requestContexts: Context[] = [];
	const { coordinator, parent } = await fixture({
		onRequestContext: (context) => requestContexts.push(context),
	});
	try {
		appendCompletedParentTurn(
			parent.sessionManager as SessionManager,
			"shared question",
			"shared answer",
		);
		const outcome = await coordinator.delegate(
			parent,
			"fork",
			{
				agent: "scout",
				task_name: "continuable-fork",
				description: "continue inherited",
				prompt: "Start inherited work.",
			},
			DEFAULT_SETTINGS,
		);
		assert.equal(outcome.kind, "continuable");
		if (outcome.kind !== "continuable") return;
		assert.equal(outcome.details.provider, "fork");
		assert.equal(outcome.details.taskPath, "/root/continuable-fork");
		await waitForChildReady(coordinator, parent, outcome.details.agentId);
		assert.equal(
			requestContexts[0]?.messages.some(
				(message) =>
					message.role === "user"
					&& userMessageText(message) === "shared question",
			),
			true,
		);

		await coordinator.sendMessage(
			parent,
			"/root/continuable-fork",
			"Continue the same fork.",
		);
		await coordinator.followupTask(parent, "/root/continuable-fork");
		await waitForChildReady(coordinator, parent, outcome.details.agentId);
		assert.equal(requestContexts.length, 2);
		// The follow-up turn carries the claimed mailbox batch.
		assert.match(
			JSON.stringify(requestContexts[1]?.messages),
			/Continue the same fork\./,
		);
	} finally {
		await coordinator.shutdown();
	}
});

test("continuable fork preserves mailbox queue, start, and quiet completion semantics", async () => {
	const { coordinator, parent, messages } = await fixture();
	try {
		appendCompletedParentTurn(
			parent.sessionManager as SessionManager,
			"mailbox context",
			"mailbox answer",
		);
		const settings = {
			...DEFAULT_SETTINGS,
		};
		const outcome = await coordinator.delegate(
			parent,
			"fork",
			{
				agent: "scout",
				task_name: "mailbox-fork",
				description: "mailbox fork",
				prompt: "Run the initial inherited turn.",
			},
			settings,
		);
		assert.equal(outcome.kind, "continuable");
		if (outcome.kind !== "continuable") return;
		await waitForChildReady(coordinator, parent, outcome.details.agentId);
		const delivery = await coordinator.sendMessageWithOutcome(
			parent,
			"mailbox-fork",
			"Run a durable follow-up.",
		);
		assert.equal(delivery.kind, "mailbox");
		const started = await coordinator.followupTask(
			parent,
			"/root/mailbox-fork",
		);
		assert.equal(started.agentId, outcome.details.agentId);
		await waitForChildReady(coordinator, parent, outcome.details.agentId);
		assert.equal(messages.length, 0);
		const waited = await coordinator.waitAgent(
			parent,
			"wait-mailbox-fork",
			0,
		);
		assert.equal(waited.updates.length, 2);
		assert.equal(
			waited.taskPaths[outcome.details.agentId],
			"/root/mailbox-fork",
		);
		appendWaitAgentToolResult(parent, "wait-mailbox-fork");
	} finally {
		await coordinator.shutdown();
	}
});

test("idle runtime LRU retains the newest child and cold-resumes an evicted path", async () => {
	const { coordinator, parent } = await fixture();
	try {
		await coordinator.configureIdleRuntimes(1);
		const settings = {
			...DEFAULT_SETTINGS,
			maxIdleRuntimes: 1,
		};
		const first = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				task_name: "first",
				description: "first idle",
				prompt: "Finish first.",
			},
			settings,
		);
		assert.equal(first.kind, "continuable");
		if (first.kind !== "continuable") return;
		await waitForChildStatus(
			coordinator,
			parent,
			first.details.agentId,
			"idle",
		);

		const second = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				task_name: "second",
				description: "second idle",
				prompt: "Finish second.",
			},
			settings,
		);
		assert.equal(second.kind, "continuable");
		if (second.kind !== "continuable") return;
		await waitForChildStatus(
			coordinator,
			parent,
			second.details.agentId,
			"idle",
		);
		await waitForChildStatus(
			coordinator,
			parent,
			first.details.agentId,
			"ready",
		);

		await coordinator.sendMessage(
			parent,
			"/root/first",
			"Cold resume the first child.",
		);
		await coordinator.followupTask(parent, "/root/first");
		await waitForChildStatus(
			coordinator,
			parent,
			first.details.agentId,
			"idle",
		);
		await waitForChildStatus(
			coordinator,
			parent,
			second.details.agentId,
			"ready",
		);
	} finally {
		await coordinator.shutdown();
	}
});

test("reusing an idle runtime emits paired activation start and end events", async () => {
	const { coordinator, parent, eventDetails } = await fixture();
	try {
		await coordinator.configureIdleRuntimes(1);
		const settings = {
			...DEFAULT_SETTINGS,
			maxIdleRuntimes: 1,
		};
		const outcome = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				task_name: "event-pairs",
				description: "event pairs",
				prompt: "Finish once.",
			},
			settings,
		);
		assert.equal(outcome.kind, "continuable");
		if (outcome.kind !== "continuable") return;
		await waitForChildStatus(
			coordinator,
			parent,
			outcome.details.agentId,
			"idle",
		);
		await coordinator.sendMessage(
			parent,
			"event-pairs",
			"Finish a second retained-runtime turn.",
		);
		await coordinator.followupTask(parent, "event-pairs");
		await waitForChildStatus(
			coordinator,
			parent,
			outcome.details.agentId,
			"idle",
		);
		const lifecycle = eventDetails.filter(
			(event) =>
				(
					event.name === "pi-subagent:start"
					|| event.name === "pi-subagent:end"
				)
				&& (event.data as { agentId?: string }).agentId
					=== outcome.details.agentId,
		);
		assert.deepEqual(
			lifecycle.map((event) => event.name),
			[
				"pi-subagent:start",
				"pi-subagent:end",
				"pi-subagent:start",
				"pi-subagent:end",
			],
		);
		const starts = lifecycle
			.filter((event) => event.name === "pi-subagent:start")
			.map((event) => (event.data as { runId: string }).runId);
		const ends = lifecycle
			.filter((event) => event.name === "pi-subagent:end")
			.map((event) => (event.data as { runId: string }).runId);
		assert.deepEqual(ends, starts);
		assert.notEqual(starts[0], starts[1]);
	} finally {
		await coordinator.shutdown();
	}
});

test("an unaccepted retained-runtime turn is silent and remains retryable", async () => {
	const { coordinator, parent, messages } = await fixture({ delayMs: 80 });
	try {
		coordinator.configureBackgroundRuns(1);
		await coordinator.configureIdleRuntimes(2);
		const settings = {
			...DEFAULT_SETTINGS,
			maxConcurrentBackgroundRuns: 1,
			maxIdleRuntimes: 2,
		};
		const retained = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				task_name: "retained",
				description: "retained child",
				prompt: "Finish the initial turn.",
			},
			settings,
		);
		assert.equal(retained.kind, "continuable");
		if (retained.kind !== "continuable") return;
		await waitForChildStatus(
			coordinator,
			parent,
			retained.details.agentId,
			"idle",
		);
		assert.equal(parentCompletions(parent).length, 1);

		const blocker = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				task_name: "blocker",
				description: "scheduler blocker",
				prompt: "Hold the only scheduler slot.",
			},
			settings,
		);
		assert.equal(blocker.kind, "continuable");
		await coordinator.sendMessage(
			parent,
			"retained",
			"This queued turn must stay silent.",
		);
		const controller = new AbortController();
		const cancelled = coordinator.followupTask(
			parent,
			"retained",
			controller.signal,
		);
		setTimeout(
			() => controller.abort(new Error("cancel queued retry")),
			10,
		);
		await assert.rejects(cancelled, /cancel queued retry/);
		await waitForChildStatus(
			coordinator,
			parent,
			retained.details.agentId,
			"idle",
		);
		// The cancelled claim leaves the batch pending and adds no completion.
		assert.equal(parentCompletions(parent).length, 1);
		const stillQueued = await coordinator.list(parent, "children");
		const retainedEntry = stillQueued.find(
			(entry) =>
				entry.kind === "child"
				&& entry.agentId === retained.details.agentId,
		);
		assert.equal(
			retainedEntry?.kind === "child"
				? retainedEntry.pendingMessages
				: undefined,
			1,
		);
		assert.equal(messages.length, 0);

		if (blocker.kind === "continuable") {
			await waitForChildStatus(
				coordinator,
				parent,
				blocker.details.agentId,
				"idle",
			);
		}
		await coordinator.followupTask(parent, "retained");
		await waitForCompletions(parent, 2);
		await waitForChildStatus(
			coordinator,
			parent,
			retained.details.agentId,
			"idle",
		);
	} finally {
		await coordinator.shutdown();
	}
});

test("concurrent settlements still enforce the idle runtime LRU limit", async () => {
	const { coordinator, parent } = await fixture({ delayMs: 30 });
	try {
		await coordinator.configureIdleRuntimes(1);
		const settings = {
			...DEFAULT_SETTINGS,
			maxIdleRuntimes: 1,
		};
		const [first, second] = await Promise.all([
			coordinator.delegate(
				parent,
				"spawn",
				{
					agent: "scout",
					task_name: "concurrent-one",
					description: "concurrent one",
					prompt: "Finish concurrently.",
				},
				settings,
			),
			coordinator.delegate(
				parent,
				"spawn",
				{
					agent: "scout",
					task_name: "concurrent-two",
					description: "concurrent two",
					prompt: "Finish concurrently.",
				},
				settings,
			),
		]);
		assert.equal(first.kind, "continuable");
		assert.equal(second.kind, "continuable");
		await waitUntil(async () => {
			const entries = await coordinator.list(parent, "children");
			const children = entries.filter(
				(entry) =>
					entry.kind === "child"
					&& (
						entry.taskPath === "/root/concurrent-one"
						|| entry.taskPath === "/root/concurrent-two"
					),
			);
			return (
				children.length === 2
				&& children.every(
					(entry) =>
						entry.kind === "child"
						&& (
							entry.status === "idle"
							|| entry.status === "ready"
						),
				)
				&& children.filter(
					(entry) =>
						entry.kind === "child"
						&& entry.status === "idle",
				).length === 1
			);
		});
	} finally {
		await coordinator.shutdown();
	}
});

test("mailbox child remains recoverable after an initial provider failure with idle LRU", async () => {
	let failFirst = true;
	const { coordinator, parent } = await fixture({
		streamSimple: (model, _context, _turn, signal) => {
			if (failFirst) {
				failFirst = false;
				throw new Error("provider failed before assistant persistence");
			}
			return scriptedStream(model, "recovered child", signal);
		},
	});
	try {
		await coordinator.configureIdleRuntimes(1);
		const settings = {
			...DEFAULT_SETTINGS,
			maxIdleRuntimes: 1,
		};
		const outcome = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				task_name: "recoverable",
				description: "recover failed child",
				prompt: "The provider will fail this turn.",
			},
			settings,
		);
		assert.equal(outcome.kind, "continuable");
		if (outcome.kind !== "continuable") return;
		await waitUntil(async () => {
			const entries = await coordinator.list(parent, "children");
			return entries.some(
				(entry) =>
					entry.kind === "child"
					&& entry.agentId === outcome.details.agentId
					&& (
						entry.status === "ready"
						|| entry.status === "idle"
					),
			);
		});

		const delivered = await coordinator.sendMessageWithOutcome(
			parent,
			"recoverable",
			"Recover from durable mailbox work.",
		);
		assert.equal(delivered.kind, "mailbox");
		await coordinator.followupTask(parent, "recoverable");
		await waitForChildStatus(
			coordinator,
			parent,
			outcome.details.agentId,
			"idle",
		);
	} finally {
		await coordinator.shutdown();
	}
});

test("OpenAI identity config injects the Codex lifecycle inline", async () => {
	const { coordinator, parent } = await fixture();
	try {
		const outcome = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "codex identity child",
				prompt: "Inspect it.",
			},
			{
				...DEFAULT_SETTINGS,
				runtimeMode: "foreground" as const,
				openAIIdentity: true,
			},
		);
		assert.equal(outcome.kind, "foreground");
		if (outcome.kind !== "foreground") return;
		assert.ok(outcome.details.sessionFile);
		const child = SessionManager.open(
			outcome.details.sessionFile,
			parent.sessionManager.getSessionDir(),
			parent.cwd,
		);
		const childIdentityEntry = [...child.getEntries()]
			.reverse()
			.find(
				(entry) =>
					entry.type === "custom"
					&& entry.customType === CODEX_IDENTITY_CUSTOM_TYPE,
			);
		assert.equal(childIdentityEntry?.type, "custom");
		if (childIdentityEntry?.type !== "custom") return;
		const childIdentity = childIdentityEntry.data as {
			sessionId: string;
			threadId: string;
			parentThreadId?: string;
		};

		const parentIdentityEntry = [...parent.sessionManager.getEntries()]
			.reverse()
			.find(
				(entry) =>
					entry.type === "custom"
					&& entry.customType === CODEX_IDENTITY_CUSTOM_TYPE,
			);
		assert.equal(parentIdentityEntry?.type, "custom");
		if (parentIdentityEntry?.type !== "custom") return;
		const parentIdentity = parentIdentityEntry.data as {
			sessionId: string;
			threadId: string;
		};
		assert.equal(parentIdentity.sessionId, parentIdentity.threadId);
		assert.equal(childIdentity.sessionId, parentIdentity.sessionId);
		assert.notEqual(childIdentity.threadId, parentIdentity.threadId);
		assert.equal(childIdentity.parentThreadId, parentIdentity.threadId);
	} finally {
		await coordinator.shutdown();
	}
});

test("OpenAI identity config off does not inject the inline lifecycle", async () => {
	const { coordinator, parent } = await fixture();
	try {
		const outcome = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "provider-neutral child",
				prompt: "Inspect it.",
			},
			{ ...DEFAULT_SETTINGS, runtimeMode: "foreground" as const, openAIIdentity: false },
		);
		assert.equal(outcome.kind, "foreground");
		if (outcome.kind !== "foreground" || !outcome.details.sessionFile) return;
		const child = SessionManager.open(
			outcome.details.sessionFile,
			parent.sessionManager.getSessionDir(),
			parent.cwd,
		);
		assert.equal(
			child
				.getEntries()
				.some(
					(entry) =>
						entry.type === "custom"
						&& entry.customType === CODEX_IDENTITY_CUSTOM_TYPE,
				),
			false,
		);
	} finally {
		await coordinator.shutdown();
	}
});

test("delegation initializes user templates before runtime discovery", async () => {
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
			},
			{ ...DEFAULT_SETTINGS, runtimeMode: "foreground" as const },
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
			},
			{ ...DEFAULT_SETTINGS, runtimeMode: "background" as const },
		);
		assert.equal(outcome.kind, "continuable");
		await waitForChildStatus(coordinator, parent, outcome.details.agentId, "ready");
		const id = outcome.details.agentId;
		const firstList = await coordinator.list(parent, "children");
		assert.equal(firstList[0]?.kind, "child");
		if (firstList[0]?.kind === "child") {
			assert.equal(firstList[0].status, "ready");
			assert.equal(firstList[0].agentId, id);
			assert.equal(firstList[0].parentAgentId, parent.agentId);
		}

		await coordinator.sendMessage(parent, id, "Inspect one more thing.");
		await coordinator.followupTask(parent, id);
		await waitForCompletions(parent, 2);
		await waitForChildStatus(coordinator, parent, id, "ready");
		const completions = parentCompletions(parent);
		assert.match(completions[0]!.output, /child answer 1/);
		assert.match(completions[1]!.output, /child answer 2/);
		assert.equal(messages.length, 0);
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

async function assertMailboxFifo(
	t: TestContext,
	maxIdleRuntimes: number,
	resolutionOrder: readonly [0 | 1, 0 | 1],
): Promise<void> {
	const requestContexts: Context[] = [];
	const {
		coordinator,
		parent,
		messages,
		eventDetails,
		agentDir,
		pi,
		context,
	} = await fixture({
		onRequestContext: (requestContext) => requestContexts.push(requestContext),
	});
	let restarted: SubagentCoordinator | undefined;
	try {
		await coordinator.configureIdleRuntimes(maxIdleRuntimes);
		const outcome = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "durable mailbox child",
				prompt: "Initial task.",
			},
			{
				...DEFAULT_SETTINGS,
				maxIdleRuntimes,
			},
		);
		assert.equal(outcome.kind, "continuable");
		if (outcome.kind !== "continuable") return;
		const settledStatus = maxIdleRuntimes > 0 ? "idle" : "ready";
		await waitForChildStatus(
			coordinator,
			parent,
			outcome.details.agentId,
			settledStatus,
		);
		const eventCount = eventDetails.length;
		assert.equal(requestContexts.length, 1);
		assert.equal(messages.length, 0);

		const inputs = ["First queued request.", "Second queued request."] as const;
		const operations = coordinator as unknown as {
			sendMessageSerialized(...args: unknown[]): Promise<unknown>;
		};
		const send = operations.sendMessageSerialized;
		let concurrentSends = 0;
		let peakSends = 0;
		const serialized = t.mock.method(operations, "sendMessageSerialized", async (...args: unknown[]) => {
			concurrentSends++;
			peakSends = Math.max(peakSends, concurrentSends);
			try {
				return await send.apply(coordinator, args);
			} finally {
				concurrentSends--;
			}
		});
		const [first, second] = await withTargetResolutionOrder(t, coordinator, resolutionOrder, [
			() => coordinator.sendMessageWithOutcome(
				parent,
				outcome.details.agentId,
				inputs[0],
			),
			() => coordinator.sendMessageWithOutcome(
				parent,
				outcome.details.taskPath,
				inputs[1],
			),
		]);
		assert.equal(serialized.mock.callCount(), 2);
		assert.equal(peakSends, 1, "path and id aliases must share one serialization queue");
		serialized.mock.restore();
		assert.equal(first.kind, "mailbox");
		assert.equal(second.kind, "mailbox");
		if (first.kind !== "mailbox" || second.kind !== "mailbox") return;
		assert.notEqual(first.messageId, second.messageId);
		assert.match(first.messageId, UUID_V7_PATTERN);
		assert.match(second.messageId, UUID_V7_PATTERN);
		const receipts = [first, second] as const;
		const expectedMessages = resolutionOrder.map((index) => ({
			messageId: receipts[index].messageId,
			content: inputs[index],
		}));
		assert.equal(receipts[resolutionOrder[0]].pendingMessages, 1);
		assert.equal(receipts[resolutionOrder[1]].pendingMessages, 2);
		for (const receipt of receipts) {
			assert.equal(receipt.agentId, outcome.details.agentId);
			assert.equal(receipt.taskPath, outcome.details.taskPath);
		}
		assert.equal(requestContexts.length, 1);
		assert.equal(messages.length, 0);
		assert.equal(eventDetails.length, eventCount);

		const queued = await coordinator.list(parent, "children");
		const child = queued.find(
			(entry) =>
				entry.kind === "child"
				&& entry.agentId === outcome.details.agentId,
		);
		assert.equal(child?.kind, "child");
		if (child?.kind !== "child") return;
		assert.equal(child.status, settledStatus);
		assert.equal(child.pendingMessages, 2);
		assert.equal(child.unreadUpdates, 1);
		assert.match(coordinator.formatCatalog(queued, "children"), /pending=2/);
		assert.ok(child.sessionFile);
		const persisted = SessionManager.open(
			child.sessionFile,
			parent.sessionManager.getSessionDir(),
			parent.cwd,
		);
		assert.deepEqual(
			readMailbox(persisted.getEntries()).pending.map(
				({ messageId, content }) => ({ messageId, content }),
			),
			expectedMessages,
		);

		await coordinator.shutdown();
		restarted = new SubagentCoordinator(
			pi,
			resolve(import.meta.dirname, "..", "agents"),
			resolve(import.meta.dirname, ".."),
			agentDir,
		);
		const restartedParent = await restarted.parentFromContext(context);
		const afterRestart = await restarted.list(restartedParent, "children");
		const restartedChild = afterRestart.find(
			(entry) =>
				entry.kind === "child"
				&& entry.agentId === outcome.details.agentId,
		);
		assert.equal(restartedChild?.kind, "child");
		if (restartedChild?.kind === "child") {
			assert.equal(restartedChild.pendingMessages, 2);
			assert.equal(restartedChild.unreadUpdates, 1);
		}

		const followup = await restarted.followupTask(
			restartedParent,
			outcome.details.agentId,
		);
		assert.match(followup.turnId, UUID_V7_PATTERN);
		assert.equal(followup.claimedMessages, 2);
		await waitUntil(() => requestContexts.length === 2);
		await waitForChildReady(
			restarted,
			restartedParent,
			outcome.details.agentId,
		);
		assert.equal(messages.length, 0);
		const serializedContext = JSON.stringify(requestContexts[1]?.messages);
		const positions = expectedMessages.map(({ content }) => serializedContext.indexOf(content));
		assert.ok(positions.every(position => position >= 0), "every queued message must reach the model");
		assert.ok(positions[0]! < positions[1]!, "replay must retain durable append order");
		const drained = await restarted.list(restartedParent, "children");
		const drainedChild = drained.find(
			(entry) =>
				entry.kind === "child"
				&& entry.agentId === outcome.details.agentId,
		);
		assert.equal(drainedChild?.kind, "child");
		if (drainedChild?.kind === "child") {
			assert.equal(drainedChild.pendingMessages, 0);
			assert.equal(drainedChild.unreadUpdates, 2);
		}
		await assert.rejects(
			() => restarted!.followupTask(restartedParent, outcome.details.agentId),
			/no pending mailbox messages/,
		);
	} finally {
		await restarted?.shutdown();
		await coordinator.shutdown();
	}
}

for (const maxIdleRuntimes of [0, 1]) {
	for (const resolutionOrder of [[0, 1], [1, 0]] as const) {
		test(
			`mailbox send_message only persists FIFO work until followup_task starts one turn (lookup=${resolutionOrder}, idle=${maxIdleRuntimes})`,
			(t) => assertMailboxFifo(t, maxIdleRuntimes, resolutionOrder),
		);
	}
}

test("mailbox completion is quiet and wait_agent durably delivers an existing update", async () => {
	const requestContexts: Context[] = [];
	const { coordinator, parent, messages } = await fixture({
		onRequestContext: (requestContext) => requestContexts.push(requestContext),
	});
	try {
		const outcome = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "quiet completion child",
				prompt: "Initial task.",
			},
			{
				...DEFAULT_SETTINGS,
			},
		);
		assert.equal(outcome.kind, "continuable");
		if (outcome.kind !== "continuable") return;
		await waitForChildReady(
			coordinator,
			parent,
			outcome.details.agentId,
		);
		assert.equal(messages.length, 0);
		assert.equal(requestContexts.length, 1);

		const before = await coordinator.list(parent, "children");
		const beforeChild = before.find(
			(entry) =>
				entry.kind === "child"
				&& entry.agentId === outcome.details.agentId,
		);
		assert.equal(beforeChild?.kind, "child");
		if (beforeChild?.kind === "child") {
			assert.equal(beforeChild.pendingMessages, 0);
			assert.equal(beforeChild.unreadUpdates, 1);
		}
		assert.match(coordinator.formatCatalog(before, "children"), /updates=1/);

		const waited = await coordinator.waitAgent(
			parent,
			"wait-existing",
			100,
		);
		assert.equal(waited.timedOut, false);
		assert.equal(waited.updates.length, 1);
		assert.equal(waited.updates[0]?.childAgentId, outcome.details.agentId);
		assert.match(waited.updates[0]?.output ?? "", /child answer 1/);
		assert.equal(waited.unreadUpdates, 0);
		assert.equal(requestContexts.length, 1);

		// The delivery remains recoverable until Pi persists this tool result.
		assert.equal(
			readCompletionMailbox(parent.sessionManager.getEntries(), {
				parentAgentId: parent.agentId,
			}).unread.length,
			1,
		);
		appendWaitAgentToolResult(parent, "wait-existing");
		assert.equal(
			readCompletionMailbox(parent.sessionManager.getEntries(), {
				parentAgentId: parent.agentId,
			}).unread.length,
			0,
		);
		const after = await coordinator.list(parent, "children");
		const afterChild = after.find(
			(entry) =>
				entry.kind === "child"
				&& entry.agentId === outcome.details.agentId,
		);
		if (afterChild?.kind === "child") {
			assert.equal(afterChild.unreadUpdates, 0);
		}
		const timeout = await coordinator.waitAgent(
			parent,
			"wait-empty",
			0,
		);
		assert.equal(timeout.timedOut, true);
		assert.deepEqual(timeout.updates, []);
	} finally {
		await coordinator.shutdown();
	}
});

test("wait_agent delivery survives failed readable-path enrichment", async () => {
	const { coordinator, parent } = await fixture();
	const originalList = SessionManager.list;
	try {
		const outcome = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				task_name: "path-fallback",
				description: "path fallback",
				prompt: "Finish once.",
			},
			{
				...DEFAULT_SETTINGS,
			},
		);
		assert.equal(outcome.kind, "continuable");
		if (outcome.kind !== "continuable") return;
		await waitForChildReady(coordinator, parent, outcome.details.agentId);
		SessionManager.list = async () => {
			throw new Error("catalog unavailable during path enrichment");
		};
		const waited = await coordinator.waitAgent(
			parent,
			"wait-path-fallback",
			0,
		);
		assert.equal(waited.updates.length, 1);
		assert.equal(
			waited.taskPaths[outcome.details.agentId],
			outcome.details.agentId,
		);
		appendWaitAgentToolResult(parent, "wait-path-fallback");
	} finally {
		SessionManager.list = originalList;
		await coordinator.shutdown();
	}
});

test("mailbox completion persistence failure emits an explicit error and no false update", async () => {
	const { coordinator, parent, messages, eventDetails } = await fixture();
	const manager = parent.sessionManager as SessionManager;
	const appendCustomEntry = manager.appendCustomEntry.bind(manager);
	manager.appendCustomEntry = (customType, data) => {
		if (customType === COMPLETION_UPDATE_CUSTOM_TYPE) {
			throw new Error("completion storage unavailable");
		}
		return appendCustomEntry(customType, data);
	};
	try {
		const outcome = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "failed completion storage",
				prompt: "Finish once.",
			},
			{
				...DEFAULT_SETTINGS,
			},
		);
		assert.equal(outcome.kind, "continuable");
		await waitUntil(() =>
			eventDetails.some(
				(event) => event.name === "pi-subagent:completion-error",
			),
		);
		assert.equal(messages.length, 0);
		assert.equal(
			readCompletionMailbox(parent.sessionManager.getEntries(), {
				parentAgentId: parent.agentId,
			}).unread.length,
			0,
		);
		const failure = eventDetails.find(
			(event) => event.name === "pi-subagent:completion-error",
		)?.data as { error?: string } | undefined;
		assert.match(failure?.error ?? "", /completion storage unavailable/);
		if (outcome.kind === "continuable") {
			await waitForChildReady(
				coordinator,
				parent,
				outcome.details.agentId,
			);
			const listed = await coordinator.list(parent, "children");
			const child = listed.find(
				(entry) =>
					entry.kind === "child"
					&& entry.agentId === outcome.details.agentId,
			);
			assert.equal(child?.kind, "child");
			if (child?.kind === "child" && child.sessionFile) {
				const persisted = SessionManager.open(
					child.sessionFile,
					parent.sessionManager.getSessionDir(),
					parent.cwd,
				);
				assert.equal(
					persisted
						.getEntries()
						.filter(
							(entry) =>
								entry.type === "custom"
								&& entry.customType
									=== COMPLETION_FAILURE_CUSTOM_TYPE,
						).length,
					1,
				);
			}
		}
	} finally {
		manager.appendCustomEntry = appendCustomEntry;
		await coordinator.shutdown();
	}
});

test("wait_agent wakes from a durable completion event without polling or starting another turn", async () => {
	const requestContexts: Context[] = [];
	const { coordinator, parent, messages, eventDetails } = await fixture({
		delayMs: 80,
		onRequestContext: (requestContext) => requestContexts.push(requestContext),
	});
	try {
		const outcome = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "event waiter child",
				prompt: "Finish after the waiter subscribes.",
			},
			{
				...DEFAULT_SETTINGS,
			},
		);
		assert.equal(outcome.kind, "continuable");
		if (outcome.kind !== "continuable") return;
		let settled = false;
		const waiting = coordinator
			.waitAgent(parent, "wait-live", 1_000)
			.then((value) => {
				settled = true;
				return value;
			});
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
		assert.equal(settled, false);
		await assert.rejects(
			() => coordinator.waitAgent(parent, "wait-competing", 100),
			/already waiting/,
		);
		const waited = await waiting;
		assert.equal(waited.timedOut, false);
		assert.equal(waited.updates.length, 1);
		assert.equal(waited.updates[0]?.childAgentId, outcome.details.agentId);
		assert.equal(messages.length, 0);
		assert.equal(requestContexts.length, 1);
		assert.equal(
			eventDetails.filter(
				(event) => event.name === "pi-subagent:turn-start",
			).length,
			1,
		);
		appendWaitAgentToolResult(parent, "wait-live");
	} finally {
		await coordinator.shutdown();
	}
});

test("a failed wait_agent delivery can be released and retried in the same runtime", async () => {
	const { coordinator, parent } = await fixture();
	try {
		const outcome = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "retry wait delivery",
				prompt: "Finish once.",
			},
			{
				...DEFAULT_SETTINGS,
			},
		);
		assert.equal(outcome.kind, "continuable");
		if (outcome.kind !== "continuable") return;
		await waitForChildReady(
			coordinator,
			parent,
			outcome.details.agentId,
		);
		const first = await coordinator.waitAgent(
			parent,
			"wait-failed-result",
			0,
		);
		assert.equal(first.timedOut, false);
		await assert.rejects(
			() => coordinator.waitAgent(parent, "wait-before-release", 0),
			/awaiting its durable tool result/,
		);
		assert.equal(
			await coordinator.releaseWaitAgentDeliveries(
				parent,
				"simulated failed tool result",
			),
			1,
		);
		const retried = await coordinator.waitAgent(
			parent,
			"wait-retried-result",
			0,
		);
		assert.equal(
			retried.updates[0]?.completionId,
			first.updates[0]?.completionId,
		);
		appendWaitAgentToolResult(parent, "wait-retried-result");
	} finally {
		await coordinator.shutdown();
	}
});

test("wait_agent bounds one oversized head without consuming the next completion", async () => {
	const { coordinator, parent } = await fixture({
		streamSimple: (model, _context, turn, signal) =>
			scriptedStream(
				model,
				(turn === 1 ? "A" : "B").repeat(400_000),
				signal,
			),
	});
	try {
		const settings = {
			...DEFAULT_SETTINGS,
			maxOutputBytes: 1024 * 1024,
		};
		const first = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "large first completion",
				prompt: "Return the first output.",
			},
			settings,
		);
		const second = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "large second completion",
				prompt: "Return the second output.",
			},
			settings,
		);
		assert.equal(first.kind, "continuable");
		assert.equal(second.kind, "continuable");
		if (first.kind !== "continuable" || second.kind !== "continuable") return;
		await waitForChildReady(coordinator, parent, first.details.agentId);
		await waitForChildReady(coordinator, parent, second.details.agentId);

		const firstWait = await coordinator.waitAgent(
			parent,
			"wait-large-first",
			0,
		);
		assert.equal(firstWait.updates.length, 1);
		assert.equal(firstWait.updates[0]?.outputTruncated, true);
		assert.equal(firstWait.unreadUpdates, 1);
		assert.match(firstWait.updates[0]?.output ?? "", /^A+$/);
		appendWaitAgentToolResult(parent, "wait-large-first");

		const secondWait = await coordinator.waitAgent(
			parent,
			"wait-large-second",
			0,
		);
		assert.equal(secondWait.updates.length, 1);
		assert.equal(
			secondWait.updates[0]?.childAgentId,
			second.details.agentId,
		);
		assert.match(secondWait.updates[0]?.output ?? "", /^B+$/);
		appendWaitAgentToolResult(parent, "wait-large-second");
	} finally {
		await coordinator.shutdown();
	}
});

test("wait_agent timeout and abort leave future completion activity untouched", async () => {
	const { coordinator, parent } = await fixture();
	try {
		const timedOut = await coordinator.waitAgent(
			parent,
			"wait-timeout",
			5,
		);
		assert.equal(timedOut.timedOut, true);
		assert.deepEqual(timedOut.updates, []);

		const abortController = new AbortController();
		const aborted = coordinator.waitAgent(
			parent,
			"wait-abort",
			1_000,
			abortController.signal,
		);
		abortController.abort(new Error("caller canceled wait"));
		await assert.rejects(() => aborted, /caller canceled wait/);

		const afterAbort = await coordinator.waitAgent(
			parent,
			"wait-after-abort",
			0,
		);
		assert.equal(afterAbort.timedOut, true);
	} finally {
		await coordinator.shutdown();
	}
});

test("shutdown rejects and cleans an event-driven wait_agent waiter", async () => {
	const { coordinator, parent } = await fixture();
	const waiting = coordinator.waitAgent(
		parent,
		"wait-shutdown",
		30_000,
	);
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
	const shutdown = coordinator.shutdown();
	await assert.rejects(() => waiting, /shutting down/);
	await shutdown;
});

test("unread mailbox completion survives coordinator and session reload", async () => {
	const {
		coordinator,
		parent,
		messages,
		agentDir,
		pi,
		context,
		model,
	} = await fixture();
	let restarted: SubagentCoordinator | undefined;
	try {
		(parent.sessionManager as SessionManager).appendMessage({
			role: "user",
			content: [{ type: "text", text: "parent checkpoint" }],
			timestamp: Date.now(),
		});
		(parent.sessionManager as SessionManager).appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "checkpointed" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
				},
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		const outcome = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "reload completion child",
				prompt: "Finish before restart.",
			},
			{
				...DEFAULT_SETTINGS,
			},
		);
		assert.equal(outcome.kind, "continuable");
		if (outcome.kind !== "continuable") return;
		await waitForChildReady(
			coordinator,
			parent,
			outcome.details.agentId,
		);
		assert.equal(messages.length, 0);
		const parentFile = parent.sessionManager.getSessionFile();
		assert.ok(parentFile);
		await coordinator.shutdown();

		const reopenedParentManager = SessionManager.open(
			parentFile,
			parent.sessionManager.getSessionDir(),
			parent.cwd,
		);
		const reopenedContext = {
			...context,
			sessionManager: reopenedParentManager,
		} as unknown as ExtensionContext;
		restarted = new SubagentCoordinator(
			pi,
			resolve(import.meta.dirname, "..", "agents"),
			resolve(import.meta.dirname, ".."),
			agentDir,
		);
		const restartedParent = await restarted.parentFromContext(
			reopenedContext,
		);
		const listed = await restarted.list(restartedParent, "children");
		const child = listed.find(
			(entry) =>
				entry.kind === "child"
				&& entry.agentId === outcome.details.agentId,
		);
		assert.equal(child?.kind, "child");
		if (child?.kind === "child") assert.equal(child.unreadUpdates, 1);
		const waited = await restarted.waitAgent(
			restartedParent,
			"wait-after-reload",
			0,
		);
		assert.equal(waited.timedOut, false);
		assert.equal(waited.updates[0]?.childAgentId, outcome.details.agentId);
	} finally {
		await restarted?.shutdown();
		await coordinator.shutdown();
	}
});

test("nested wait_agent consumes only direct-child completion from the parent session", async () => {
	const { coordinator, parent, messages } = await fixture({
		streamSimple: (model, context, turn, signal) => {
			const toolResults = context.messages.filter(
				(message) => message.role === "toolResult",
			);
			const hasNestedControls = getCurrentTools(context.messages).some(
				(tool) => tool.name === "wait_agent",
			);
			if (!hasNestedControls) {
				return scriptedStream(
					model,
					"grandchild complete",
					signal,
				);
			}
			const latestToolResult = toolResults.at(-1);
			if (!latestToolResult) {
				return toolCallStream(model, {
					type: "toolCall",
					id: `nested-subagent-${turn}`,
					name: "subagent",
					arguments: {
						agent: "scout",
						description: "nested mailbox child",
						prompt: "Complete nested work.",
					},
				});
			}
			if (latestToolResult.toolName === "subagent") {
				return toolCallStream(model, {
					type: "toolCall",
					id: `nested-wait-${turn}`,
					name: "wait_agent",
					arguments: { timeout_ms: 1_000 },
				});
			}
			return scriptedStream(model, "worker consumed grandchild", signal);
		},
	});
	try {
		const outcome = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "worker",
				description: "nested mailbox parent",
				prompt: "Spawn and wait for one direct child.",
			},
			{
				...DEFAULT_SETTINGS,
			},
		);
		assert.equal(outcome.kind, "continuable");
		if (outcome.kind !== "continuable") return;
		await waitForChildReady(
			coordinator,
			parent,
			outcome.details.agentId,
		);
		assert.equal(messages.length, 0);
		const descendants = await coordinator.list(parent, "descendants");
		const worker = descendants.find(
			(entry) =>
				entry.kind === "child"
				&& entry.agentId === outcome.details.agentId,
		);
		const grandchild = descendants.find(
			(entry) =>
				entry.kind === "child"
				&& entry.descriptor.label === "nested mailbox child",
		);
		assert.equal(worker?.kind, "child");
		assert.equal(grandchild?.kind, "child");
		if (worker?.kind === "child") {
			assert.equal(
				worker.taskPath,
				"/root/nested-mailbox-parent",
			);
			assert.equal(worker.unreadUpdates, 1);
		}
		if (grandchild?.kind === "child") {
			assert.equal(
				grandchild.taskPath,
				"/root/nested-mailbox-parent/nested-mailbox-child",
			);
			assert.equal(grandchild.parentAgentId, outcome.details.agentId);
			assert.equal(grandchild.unreadUpdates, 0);
		}
		const rootWait = await coordinator.waitAgent(
			parent,
			"wait-worker-only",
			0,
		);
		assert.equal(rootWait.updates.length, 1);
		assert.equal(
			rootWait.updates[0]?.childAgentId,
			outcome.details.agentId,
		);
		appendWaitAgentToolResult(parent, "wait-worker-only");
	} finally {
		await coordinator.shutdown();
	}
});

test("concurrent mailbox followup_task calls cannot claim or start the same batch twice", async () => {
	const requestContexts: Context[] = [];
	const { coordinator, parent, messages } = await fixture({
		delayMs: 50,
		onRequestContext: (requestContext) => requestContexts.push(requestContext),
	});
	try {
		const outcome = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "single claim child",
				prompt: "Initial task.",
			},
			{
				...DEFAULT_SETTINGS,
			},
		);
		assert.equal(outcome.kind, "continuable");
		if (outcome.kind !== "continuable") return;
		await waitForChildReady(
			coordinator,
			parent,
			outcome.details.agentId,
		);
		await coordinator.sendMessage(
			parent,
			outcome.details.agentId,
			"Claim exactly once.",
		);

		const attempts = await Promise.allSettled([
			coordinator.followupTask(parent, outcome.details.agentId),
			coordinator.followupTask(parent, outcome.details.agentId),
		]);
		assert.equal(
			attempts.filter((attempt) => attempt.status === "fulfilled").length,
			1,
		);
		assert.equal(
			attempts.filter((attempt) => attempt.status === "rejected").length,
			1,
		);
		await waitForChildReady(
			coordinator,
			parent,
			outcome.details.agentId,
		);
		assert.equal(messages.length, 0);
		assert.equal(requestContexts.length, 2);
		const listed = await coordinator.list(parent, "children");
		const child = listed.find(
			(entry) =>
				entry.kind === "child"
				&& entry.agentId === outcome.details.agentId,
		);
		assert.equal(child?.kind, "child");
		if (child?.kind !== "child" || !child.sessionFile) return;
		const persisted = SessionManager.open(
			child.sessionFile,
			parent.sessionManager.getSessionDir(),
			parent.cwd,
		);
		const claims = persisted
			.getEntries()
			.filter(
				(entry) =>
					entry.type === "custom"
					&& entry.customType === MAILBOX_CLAIM_CUSTOM_TYPE,
			);
		assert.equal(claims.length, 1);
		const commits = persisted
			.getEntries()
			.filter(
				(entry) =>
					entry.type === "custom"
					&& entry.customType === MAILBOX_COMMIT_CUSTOM_TYPE,
			);
		assert.equal(commits.length, 1);
	} finally {
		await coordinator.shutdown();
	}
});

test("mailbox enqueue waits for a newly accepted child session to become durable", async () => {
	const requestContexts: Context[] = [];
	const { coordinator, parent, messages } = await fixture({
		delayMs: 60,
		onRequestContext: (requestContext) => requestContexts.push(requestContext),
	});
	try {
		const outcome = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "initially unflushed child",
				prompt: "Initial task.",
			},
			{
				...DEFAULT_SETTINGS,
			},
		);
		assert.equal(outcome.kind, "continuable");
		if (outcome.kind !== "continuable") return;
		let accepted = false;
		const enqueue = coordinator
			.sendMessageWithOutcome(
				parent,
				outcome.details.agentId,
				"Persist after the first assistant entry.",
			)
			.then((delivery) => {
				accepted = true;
				return delivery;
			});
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
		assert.equal(accepted, false);
		const delivery = await enqueue;
		assert.equal(delivery.kind, "mailbox");
		assert.equal(requestContexts.length, 1);
		await waitForChildReady(
			coordinator,
			parent,
			outcome.details.agentId,
		);
		assert.equal(messages.length, 0);
		const listed = await coordinator.list(parent, "children");
		const child = listed.find(
			(entry) =>
				entry.kind === "child"
				&& entry.agentId === outcome.details.agentId,
		);
		assert.equal(child?.kind, "child");
		if (child?.kind === "child") assert.equal(child.pendingMessages, 1);
	} finally {
		await coordinator.shutdown();
	}
});

test("mailbox prompt preflight failure leaves the unclaimed batch pending", async () => {
	const { coordinator, parent, messages, modelRuntime } = await fixture();
	try {
		const outcome = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "preflight mailbox child",
				prompt: "Initial task.",
			},
			{
				...DEFAULT_SETTINGS,
			},
		);
		assert.equal(outcome.kind, "continuable");
		if (outcome.kind !== "continuable") return;
		await waitForChildReady(
			coordinator,
			parent,
			outcome.details.agentId,
		);
		await coordinator.sendMessage(
			parent,
			outcome.details.agentId,
			"Do not lose this batch.",
		);
		const registered = modelRuntime.getRegisteredProviderConfig("scripted");
		assert.ok(registered);
		modelRuntime.unregisterProvider("scripted");
		const { apiKey: _apiKey, ...withoutAuth } = registered;
		modelRuntime.registerProvider("scripted", withoutAuth);
		await assert.rejects(
			() => coordinator.followupTask(parent, outcome.details.agentId),
			/prompt was rejected before acceptance/,
		);
		const listed = await coordinator.list(parent, "children");
		const child = listed.find(
			(entry) =>
				entry.kind === "child"
				&& entry.agentId === outcome.details.agentId,
		);
		assert.equal(child?.kind, "child");
		if (child?.kind !== "child" || !child.sessionFile) return;
		assert.equal(child.pendingMessages, 1);
		const persisted = SessionManager.open(
			child.sessionFile,
			parent.sessionManager.getSessionDir(),
			parent.cwd,
		);
		assert.equal(
			persisted
				.getEntries()
				.filter(
					(entry) =>
						entry.type === "custom"
						&& entry.customType === MAILBOX_CLAIM_CUSTOM_TYPE,
				).length,
			0,
		);
	} finally {
		await coordinator.shutdown();
	}
});

test("mailbox commits a claimed turn even when an input extension transforms its prompt", async () => {
	const childExtension = `
export default function transformMailbox(pi) {
	pi.on("input", async (event) => {
		if (event.text.startsWith("[[pi-subagent-mailbox-turn:")) {
			return { action: "transform", text: "extension prefix\\n" + event.text };
		}
		return { action: "continue" };
	});
}
`;
	const { coordinator, parent, messages } = await fixture({ childExtension });
	try {
		const outcome = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "transformed mailbox child",
				prompt: "Initial task.",
			},
			{
				...DEFAULT_SETTINGS,
				inheritExtensions: true,
			},
		);
		assert.equal(outcome.kind, "continuable");
		if (outcome.kind !== "continuable") return;
		await waitForChildReady(
			coordinator,
			parent,
			outcome.details.agentId,
		);
		await coordinator.sendMessage(
			parent,
			outcome.details.agentId,
			"Transform but consume once.",
		);
		await coordinator.followupTask(parent, outcome.details.agentId);
		await waitForChildReady(
			coordinator,
			parent,
			outcome.details.agentId,
		);
		assert.equal(messages.length, 0);
		const listed = await coordinator.list(parent, "children");
		const child = listed.find(
			(entry) =>
				entry.kind === "child"
				&& entry.agentId === outcome.details.agentId,
		);
		assert.equal(child?.kind, "child");
		if (child?.kind === "child") assert.equal(child.pendingMessages, 0);
	} finally {
		await coordinator.shutdown();
	}
});

test("mailbox rejects an input-handled prompt without claiming its batch", async () => {
	const childExtension = `
export default function handleMailbox(pi) {
	pi.on("input", async (event) => {
		if (event.text.startsWith("[[pi-subagent-mailbox-turn:")) {
			return { action: "handled" };
		}
		return { action: "continue" };
	});
}
`;
	const { coordinator, parent, messages } = await fixture({ childExtension });
	try {
		const outcome = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "handled mailbox child",
				prompt: "Initial task.",
			},
			{
				...DEFAULT_SETTINGS,
				inheritExtensions: true,
			},
		);
		assert.equal(outcome.kind, "continuable");
		if (outcome.kind !== "continuable") return;
		await waitForChildReady(
			coordinator,
			parent,
			outcome.details.agentId,
		);
		await coordinator.sendMessage(
			parent,
			outcome.details.agentId,
			"Keep this pending.",
		);
		await assert.rejects(
			() => coordinator.followupTask(parent, outcome.details.agentId),
			/handled before a user turn started/,
		);
		const listed = await coordinator.list(parent, "children");
		const child = listed.find(
			(entry) =>
				entry.kind === "child"
				&& entry.agentId === outcome.details.agentId,
		);
		assert.equal(child?.kind, "child");
		if (child?.kind !== "child" || !child.sessionFile) return;
		assert.equal(child.pendingMessages, 1);
		const persisted = SessionManager.open(
			child.sessionFile,
			parent.sessionManager.getSessionDir(),
			parent.cwd,
		);
		assert.equal(
			persisted
				.getEntries()
				.filter(
					(entry) =>
						entry.type === "custom"
						&& entry.customType === MAILBOX_CLAIM_CUSTOM_TYPE,
				).length,
			0,
		);
	} finally {
		await coordinator.shutdown();
	}
});

test("interrupting a mailbox followup while it waits for capacity preserves its batch", async () => {
	let releaseHolder!: () => void;
	const holder = new Promise<void>((resolve) => { releaseHolder = resolve; });
	let holding = false;
	const { coordinator, parent, messages } = await fixture({
		streamSimple(model, context, turn, signal) {
			const lastUser = context.messages.filter((message) => message.role === "user").at(-1);
			if (!lastUser || !userMessageText(lastUser).includes("Hold the only slot.")) {
				return scriptedStream(model, `child answer ${turn}`, signal);
			}
			holding = true;
			const stream = createAssistantMessageEventStream();
			void holder.then(async () => {
				for await (const event of scriptedStream(model, `child answer ${turn}`, signal)) stream.push(event);
				stream.end();
			});
			return stream;
		},
	});
	coordinator.configureBackgroundRuns(1);
	try {
		const settings = {
			...DEFAULT_SETTINGS,
			maxConcurrentBackgroundRuns: 1,
		};
		const first = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "capacity holder",
				prompt: "Initial first task.",
			},
			settings,
		);
		assert.equal(first.kind, "continuable");
		await waitForChildReady(
			coordinator,
			parent,
			first.details.agentId,
		);
		const second = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "queued mailbox child",
				prompt: "Initial second task.",
			},
			settings,
		);
		assert.equal(second.kind, "continuable");
		await waitForChildReady(
			coordinator,
			parent,
			second.details.agentId,
		);
		assert.equal(messages.length, 0);
		if (first.kind !== "continuable" || second.kind !== "continuable") return;

		await coordinator.sendMessage(
			parent,
			first.details.agentId,
			"Hold the only slot.",
		);
		await coordinator.sendMessage(
			parent,
			second.details.agentId,
			"Remain pending if interrupted.",
		);
		await coordinator.followupTask(parent, first.details.agentId);
		await waitUntil(() => holding);
		const blocked = coordinator.followupTask(parent, second.details.agentId);
		const interrupted = assert.rejects(blocked, /interrupted/);
		await waitUntil(async () => {
			const entries = await coordinator.list(parent, "children");
			return entries.some(
				(entry) =>
					entry.kind === "child"
					&& entry.agentId === second.details.agentId
					&& entry.status === "running",
			);
		});
		await coordinator.interrupt(parent, second.details.agentId);
		await interrupted;
		await waitUntil(async () => {
			const entries = await coordinator.list(parent, "children");
			const child = entries.find(
				(entry) =>
					entry.kind === "child"
					&& entry.agentId === second.details.agentId,
			);
			return child?.kind === "child"
				&& child.status === "ready"
				&& child.pendingMessages === 1;
		});
	} finally {
		releaseHolder();
		await coordinator.shutdown();
	}
});

test("concurrent messages cold-resume one runtime and preserve one lifecycle", async () => {
	const { coordinator, parent, messages, events, eventDetails } = await fixture({
		delayMs: 30,
	});
	try {
		const outcome = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "serialized cold child",
				prompt: "Initial task.",
			},
			{ ...DEFAULT_SETTINGS, runtimeMode: "background" as const },
		);
		assert.equal(outcome.kind, "continuable");
		await waitForCompletions(parent, 1);

		await Promise.all([
			coordinator.sendMessage(parent, outcome.details.agentId, "First follow-up."),
			coordinator.sendMessage(parent, outcome.details.agentId, "Second follow-up."),
		]);
		// Enqueue-only delivery starts no turn and produces no new completion.
		assert.equal(parentCompletions(parent).length, 1);
		await coordinator.followupTask(parent, outcome.details.agentId);
		await waitForCompletions(parent, 2);
		assert.deepEqual(events, [
			"pi-subagent:start",
			"pi-subagent:end",
			"pi-subagent:start",
			"pi-subagent:end",
		]);
		assert.match(parentCompletions(parent)[1]!.output, /child answer 2/);
		assert.equal(messages.length, 0);
		const turnStarts = eventDetails
			.filter((event) => event.name === "pi-subagent:turn-start")
			.map((event) => (event.data as { turnId: string }).turnId);
		const turnEnds = eventDetails
			.filter((event) => event.name === "pi-subagent:turn-end")
			.map((event) => (event.data as { turnId: string }).turnId);
		assert.deepEqual(turnEnds, turnStarts);
	} finally {
		await coordinator.shutdown();
	}
});

test("a resident agent waiting on descendants can accept a follow-up", async () => {
	let requests = 0;
	const { coordinator, parent, eventDetails } = await fixture({
		delayMs: 20,
		onRequestContext: () => {
			requests += 1;
		},
	});
	try {
		const outcome = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "waiting parent",
				prompt: "Complete while a descendant remains active.",
			},
			{ ...DEFAULT_SETTINGS, runtimeMode: "background" as const },
		);
		assert.equal(outcome.kind, "continuable");
		const active = (
			coordinator as unknown as {
				active: Map<
					string,
					{
						ownedChildren: Set<string>;
						currentRun?: Promise<unknown>;
					}
				>;
			}
		).active.get(outcome.details.agentId);
		assert.ok(active);
		active.ownedChildren.add("test-descendant");
		await active.currentRun;

		await coordinator.sendMessage(
			parent,
			outcome.details.agentId,
			"Continue while the descendant is still active.",
		);
		const followup = coordinator.followupTask(
			parent,
			outcome.details.agentId,
		);
		await waitUntil(() => requests === 2);
		await followup;
		await active.currentRun;
		const starts = eventDetails
			.filter((event) => event.name === "pi-subagent:turn-start")
			.map((event) => (event.data as { turnId: string }).turnId);
		const ends = eventDetails
			.filter((event) => event.name === "pi-subagent:turn-end")
			.map((event) => (event.data as { turnId: string }).turnId);
		assert.equal(new Set(starts).size, 2);
		assert.deepEqual(ends, starts);
	} finally {
		await coordinator.shutdown();
	}
});

test("a follow-up cannot start while the previous turn is still running", async () => {
	const { coordinator, parent } = await fixture({ delayMs: 80 });
	try {
		const outcome = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "busy follow-up target",
				prompt: "Finish the initial turn.",
			},
			{ ...DEFAULT_SETTINGS, runtimeMode: "background" as const },
		);
		assert.equal(outcome.kind, "continuable");
		if (outcome.kind !== "continuable") return;
		await waitForChildReady(coordinator, parent, outcome.details.agentId);

		await coordinator.sendMessage(
			parent,
			outcome.details.agentId,
			"Run the first follow-up.",
		);
		await coordinator.followupTask(parent, outcome.details.agentId);
		// The accepted turn still owns the child, so the next batch cannot
		// start; the message stays pending instead of being lost.
		await coordinator.sendMessage(
			parent,
			outcome.details.agentId,
			"Queue this behind the running turn.",
		);
		await assert.rejects(
			() => coordinator.followupTask(parent, outcome.details.agentId),
			/already has a scheduled or running turn/,
		);
		const queued = await coordinator.list(parent, "children");
		const target = queued.find(
			(entry) =>
				entry.kind === "child"
				&& entry.agentId === outcome.details.agentId,
		);
		assert.equal(
			target?.kind === "child" ? target.pendingMessages : undefined,
			1,
		);

		await waitForCompletions(parent, 2);
		const retried = await coordinator.followupTask(
			parent,
			outcome.details.agentId,
		);
		assert.equal(retried.claimedMessages, 1);
		await waitForCompletions(parent, 3);
	} finally {
		await coordinator.shutdown();
	}
});

test("background turns obey the configured concurrency limit", async () => {
	let activeStreams = 0;
	let maxActiveStreams = 0;
	const { coordinator, parent, messages } = await fixture({
		delayMs: 80,
		onStreamStart: () => {
			activeStreams += 1;
			maxActiveStreams = Math.max(maxActiveStreams, activeStreams);
		},
		onStreamEnd: () => {
			activeStreams -= 1;
		},
	});
	try {
		coordinator.configureBackgroundRuns(2);
		const settings = {
			...DEFAULT_SETTINGS,
			runtimeMode: "background" as const,
			maxConcurrentBackgroundRuns: 2,
		};
		const outcomes = await Promise.all(
			["one", "two", "three"].map((description) =>
				coordinator.delegate(
					parent,
					"spawn",
					{
						agent: "scout",
						description,
						prompt: `Task ${description}.`,
					},
					settings,
				),
			),
		);
		assert.equal(
			outcomes.every((outcome) => outcome.kind === "continuable"),
			true,
		);
		await waitForCompletions(parent, 3);
		assert.equal(maxActiveStreams, 2);
		assert.equal(activeStreams, 0);
	} finally {
		await coordinator.shutdown();
	}
});

test("interrupt cancels a background turn while it waits for capacity", async () => {
	const { coordinator, parent, messages, eventDetails } = await fixture({
		delayMs: 120,
	});
	try {
		coordinator.configureBackgroundRuns(1);
		const settings = {
			...DEFAULT_SETTINGS,
			runtimeMode: "background" as const,
			maxConcurrentBackgroundRuns: 1,
		};
		const first = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "capacity holder",
				prompt: "Hold the only background slot.",
			},
			settings,
		);
		assert.equal(first.kind, "continuable");

		let queuedAgentId: string | undefined;
		const queued = coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "queued child",
				prompt: "This should be interrupted while queued.",
			},
			settings,
			undefined,
			(details) => {
				queuedAgentId = details.agentId;
			},
		);
		await waitUntil(() => queuedAgentId !== undefined);
		await coordinator.interrupt(parent, queuedAgentId!);
		await assert.rejects(queued, /was interrupted/);
		await waitForCompletions(parent, 1);
		assert.equal(messages.length, 0);
		assert.deepEqual(
			eventDetails.filter(
				(event) =>
					(event.data as { agentId?: string }).agentId === queuedAgentId &&
					(event.name === "pi-subagent:turn-start" ||
						event.name === "pi-subagent:turn-end"),
			),
			[],
		);
	} finally {
		await coordinator.shutdown();
	}
});

test("interrupt cancels a cold follow-up while it waits for capacity and keeps its batch", async () => {
	const { coordinator, parent } = await fixture({ delayMs: 100 });
	try {
		coordinator.configureBackgroundRuns(4);
		const initial = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "cold follow-up target",
				prompt: "Create the durable target.",
			},
			{
				...DEFAULT_SETTINGS,
				runtimeMode: "background" as const,
				maxConcurrentBackgroundRuns: 4,
			},
		);
		assert.equal(initial.kind, "continuable");
		await waitForCompletions(parent, 1);
		coordinator.configureBackgroundRuns(1);

		const holder = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "follow-up capacity holder",
				prompt: "Hold the only slot.",
			},
			{
				...DEFAULT_SETTINGS,
				runtimeMode: "background" as const,
				maxConcurrentBackgroundRuns: 1,
			},
		);
		assert.equal(holder.kind, "continuable");

		await coordinator.sendMessage(
			parent,
			initial.details.agentId,
			"Queue the first cold follow-up.",
		);
		const firstFollowUp = coordinator.followupTask(
			parent,
			initial.details.agentId,
		);
		await waitUntil(async () => {
			const entries = await coordinator.list(parent, "children");
			return entries.some(
				(entry) =>
					entry.kind === "child" &&
					entry.agentId === initial.details.agentId &&
				entry.status === "running",
			);
		});
		await coordinator.interrupt(parent, initial.details.agentId);
		await assert.rejects(firstFollowUp, /was interrupted/);
		// The unclaimed batch survives the interruption and stays retryable.
		await waitForChildStatus(
			coordinator,
			parent,
			initial.details.agentId,
			"ready",
		);
		assert.equal(parentCompletions(parent).length, 1);
		const pending = await coordinator.list(parent, "children");
		const pendingEntry = pending.find(
			(entry) =>
				entry.kind === "child"
				&& entry.agentId === initial.details.agentId,
		);
		assert.equal(
			pendingEntry?.kind === "child"
				? pendingEntry.pendingMessages
				: undefined,
			1,
		);
		// The capacity holder settles on its own before the batch is retried.
		await waitForCompletions(parent, 2);
		const retried = await coordinator.followupTask(
			parent,
			initial.details.agentId,
		);
		assert.equal(retried.claimedMessages, 1);
		await waitForCompletions(parent, 3);
	} finally {
		await coordinator.shutdown();
	}
});

test("interrupting a queued resident follow-up keeps later completions flowing", async () => {
	const { coordinator, parent } = await fixture({ delayMs: 60 });
	try {
		coordinator.configureBackgroundRuns(1);
		const settings = {
			...DEFAULT_SETTINGS,
			runtimeMode: "background" as const,
			maxConcurrentBackgroundRuns: 1,
		};
		const waiting = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "resident waiting child",
				prompt: "Finish while retaining a descendant.",
			},
			settings,
		);
		assert.equal(waiting.kind, "continuable");
		const active = (
			coordinator as unknown as {
				active: Map<
					string,
					{
						ownedChildren: Set<string>;
						currentRun?: Promise<unknown>;
						suppressSettlement: boolean;
					}
				>;
			}
		).active.get(waiting.details.agentId);
		assert.ok(active);
		active.ownedChildren.add("test-descendant");
		await active.currentRun;

		const holder = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "resident capacity holder",
				prompt: "Hold the slot during the interrupted follow-up.",
			},
			settings,
		);
		assert.equal(holder.kind, "continuable");

		await coordinator.sendMessage(
			parent,
			waiting.details.agentId,
			"Queue this resident follow-up.",
		);
		const interrupted = coordinator.followupTask(
			parent,
			waiting.details.agentId,
		);
		await waitUntil(async () => {
			const entries = await coordinator.list(parent, "children");
			return entries.some(
				(entry) =>
					entry.kind === "child" &&
					entry.agentId === waiting.details.agentId &&
					entry.status === "running",
			);
		});
		await coordinator.interrupt(parent, waiting.details.agentId);
		await assert.rejects(interrupted, /was interrupted/);
		await waitUntil(() => active.currentRun === undefined);
		assert.equal(active.suppressSettlement, false);
		assert.equal(parentCompletions(parent).length, 1);

		await coordinator.sendMessage(
			parent,
			waiting.details.agentId,
			"Run successfully after the interruption.",
		);
		await coordinator.followupTask(parent, waiting.details.agentId);
		await waitUntil(() => active.currentRun === undefined);
		active.ownedChildren.delete("test-descendant");
		await (
			coordinator as unknown as {
				finalizeContinuable(activation: unknown): Promise<void>;
			}
		).finalizeContinuable(active);
		await waitForCompletions(parent, 2);
		assert.match(parentCompletions(parent)[1]!.output, /child answer 2/);
	} finally {
		await coordinator.shutdown();
	}
});

test("shutdown rejects a send_message already queued on the agent lock", async () => {
	const { coordinator, parent } = await fixture({ delayMs: 120 });
	let shutdownComplete = false;
	try {
		const outcome = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "shutdown child",
				prompt: "Stay active during shutdown.",
			},
			{ ...DEFAULT_SETTINGS, runtimeMode: "background" as const },
		);
		assert.equal(outcome.kind, "continuable");

		const operations = (
			coordinator as unknown as {
				agentOperations: {
					run<T>(agentId: string, operation: () => Promise<T>): Promise<T>;
				};
			}
		).agentOperations;
		let blockerStarted = false;
		let releaseBlocker!: () => void;
		const blockerGate = new Promise<void>((resolve) => {
			releaseBlocker = resolve;
		});
		const blocker = operations.run(outcome.details.agentId, async () => {
			blockerStarted = true;
			await blockerGate;
		});
		await waitUntil(() => blockerStarted);

		const queuedSend = coordinator.sendMessage(
			parent,
			outcome.details.agentId,
			"Must not run after shutdown starts.",
		);
		const shutdown = coordinator.shutdown().then(() => {
			shutdownComplete = true;
		});
		releaseBlocker();
		await blocker;
		await assert.rejects(queuedSend, /shutting down/);
		await shutdown;
	} finally {
		if (!shutdownComplete) await coordinator.shutdown();
	}
});

test("concurrent shutdown callers wait for an in-flight delegation", async () => {
	const { coordinator, parent, eventDetails } = await fixture({ delayMs: 120 });
	const delegation = coordinator.delegate(
		parent,
		"spawn",
		{
			agent: "scout",
			description: "in-flight foreground child",
			prompt: "Remain active until shutdown.",
		},
		{ ...DEFAULT_SETTINGS, runtimeMode: "foreground" as const },
	);
	await waitUntil(() =>
		eventDetails.some((event) => event.name === "pi-subagent:turn-start"),
	);
	await Promise.all([coordinator.shutdown(), coordinator.shutdown()]);
	const outcome = await delegation;
	assert.equal(outcome.kind, "foreground");
	if (outcome.kind === "foreground") {
		assert.equal(outcome.result.stopReason, "aborted");
	}
	assert.equal(
		(
			coordinator as unknown as {
				active: Map<string, unknown>;
			}
		).active.size,
		0,
	);
});

test("interrupt stops only the live activation and preserves its resumable session", async () => {
	const { coordinator, parent } = await fixture({ delayMs: 100 });
	try {
		const outcome = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "interruptible scout",
				prompt: "Keep working.",
			},
			{ ...DEFAULT_SETTINGS, runtimeMode: "background" as const },
		);
		assert.equal(outcome.kind, "continuable");
		await coordinator.interrupt(parent, outcome.details.agentId);
		await waitForCompletions(parent, 1);
		assert.equal(parentCompletions(parent)[0]!.stopReason, "aborted");
		const entries = await coordinator.list(parent, "children");
		assert.equal(entries[0]?.kind, "child");
		if (entries[0]?.kind === "child") assert.equal(entries[0].status, "ready");
	} finally {
		await coordinator.shutdown();
	}
});

test("agent ids are a durable namespace distinct from pi session ids", async () => {
	const { coordinator, parent } = await fixture();
	try {
		const outcome = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "id semantics scout",
				prompt: "Inspect it.",
			},
			{ ...DEFAULT_SETTINGS, runtimeMode: "background" as const },
		);
		assert.equal(outcome.kind, "continuable");
		if (outcome.kind !== "continuable") return;
		const { agentId, piSessionId, sessionFile } = outcome.details;
		assert.match(agentId, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
		assert.ok(piSessionId);
		assert.ok(sessionFile);
		assert.notEqual(agentId, piSessionId);
		assert.notEqual(agentId, parent.agentId);
		// The persisted parent session gets a durable agent id of its own,
		// distinct from its pi session (file) id.
		assert.notEqual(parent.agentId, parent.sessionManager.getSessionId());
		// The child session file is flushed once its first assistant message
		// lands; wait for the run to settle before reading it back.
		await waitForCompletions(parent, 1);

		// The child session records its agent id and descriptor, and the
		// descriptor's parent chain points at the parent's durable agent id.
		const child = SessionManager.open(
			sessionFile,
			parent.sessionManager.getSessionDir(),
			parent.cwd,
		);
		const folded = foldDescriptor(child.getEntries());
		assert.equal(folded.kind, "valid");
		if (folded.kind === "valid") {
			assert.equal(folded.descriptor.agentId, agentId);
			assert.equal(folded.descriptor.parentAgentId, parent.agentId);
		}
		const childAgentEntries = child
			.getEntries()
			.filter(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === AGENT_CUSTOM_TYPE &&
					(entry.data as { agentId?: string } | undefined)?.agentId === agentId,
			);
		assert.equal(childAgentEntries.length, 1);

		// The parent session persists the same agent id, so a forked or
		// re-created parent session file keeps the child tree addressable.
		const parentAgentEntries = parent.sessionManager
			.getEntries()
			.filter(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === AGENT_CUSTOM_TYPE &&
					(entry.data as { agentId?: string } | undefined)?.agentId === parent.agentId,
			);
		assert.equal(parentAgentEntries.length, 1);
	} finally {
		await coordinator.shutdown();
	}
});

test("resumed children keep their agent id across cold starts", async () => {
	const { coordinator, parent } = await fixture();
	try {
		const outcome = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "resumable scout",
				prompt: "Inspect it.",
			},
			{ ...DEFAULT_SETTINGS, runtimeMode: "background" as const },
		);
		assert.equal(outcome.kind, "continuable");
		if (outcome.kind !== "continuable") return;
		const agentId = outcome.details.agentId;
		await waitForCompletions(parent, 1);

		await coordinator.sendMessage(parent, agentId, "Inspect one more thing.");
		await coordinator.followupTask(parent, agentId);
		await waitForCompletions(parent, 2);
		const entries = await coordinator.list(parent, "children");
		assert.equal(entries.length, 1);
		assert.equal(entries[0]?.kind, "child");
		if (entries[0]?.kind === "child") assert.equal(entries[0].agentId, agentId);
	} finally {
		await coordinator.shutdown();
	}
});

test("fork children get a fresh agent id while chaining to the parent agent", async () => {
	const { coordinator, parent } = await fixture();
	try {
		const outcome = await coordinator.delegate(
			parent,
			"fork",
			{
				agent: "scout",
				description: "forked scout",
				prompt: "Inspect it.",
			},
			{ ...DEFAULT_SETTINGS, runtimeMode: "foreground" as const },
		);
		assert.equal(outcome.kind, "foreground");
		if (outcome.kind !== "foreground") return;
		assert.notEqual(outcome.details.agentId, parent.agentId);
		assert.match(
			outcome.details.agentId,
			/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
		);
	} finally {
		await coordinator.shutdown();
	}
});

test("continuable child can explicitly report before its quiet completion", async () => {
	const { coordinator, parent, messages } = await fixture({ reportFirst: true });
	try {
		await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "reporting scout",
				prompt: "Report a finding.",
			},
			{ ...DEFAULT_SETTINGS, runtimeMode: "background" as const },
		);
		await waitUntil(() => messages.length === 1);
		assert.match(messages[0]!.content, /reported:[\s\S]*finding 1/);
		await waitForCompletions(parent, 1);
		assert.match(parentCompletions(parent)[0]!.output, /child answer 2/);
	} finally {
		await coordinator.shutdown();
	}
});

test("a report is delivered without starting or queueing a parent turn", async () => {
	const { coordinator, parent, messages, eventDetails } = await fixture({
		reportFirst: true,
	});
	try {
		const outcome = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "reporting scout",
				prompt: "Report a finding.",
			},
			DEFAULT_SETTINGS,
		);
		assert.equal(outcome.kind, "continuable");
		if (outcome.kind !== "continuable") return;
		await waitForChildReady(
			coordinator,
			parent,
			outcome.details.agentId,
		);
		assert.equal(messages.length, 1);
		assert.match(messages[0]!.content, /reported:[\s\S]*finding 1/);
		// The report is recorded for the parent session without waking it: no
		// additional parent turn, scheduler slot or activation is created.
		assert.equal(
			eventDetails.filter(
				(event) => event.name === "pi-subagent:turn-start",
			).length,
			1,
		);
		const listed = await coordinator.list(parent, "children");
		const child = listed.find(
			(entry) =>
				entry.kind === "child"
				&& entry.agentId === outcome.details.agentId,
		);
		if (child?.kind === "child") assert.equal(child.unreadUpdates, 1);
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
					},
					{ ...DEFAULT_SETTINGS, runtimeMode: "background" as const },
				),
			/require a persisted parent session/,
		);
	} finally {
		await coordinator.shutdown();
	}
});

test("foreground mode waits for the child result", async () => {
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
				runtimeMode: "foreground" as const,
			},
		);
		assert.equal(outcome.kind, "foreground");
		if (outcome.kind === "foreground") assert.equal(outcome.result.output, "child answer 1");
		assert.deepEqual(events, ["pi-subagent:start", "pi-subagent:end"]);
	} finally {
		await coordinator.shutdown();
	}
});

test("foreground mode requires a fresh child for every delegation", async () => {
	const { coordinator, parent, events } = await fixture();
	try {
		for (const description of ["first scout", "second scout"]) {
			const outcome = await coordinator.delegate(
				parent,
				"spawn",
				{
					agent: "scout",
					description,
					prompt: "Inspect it.",
				},
				{
					...DEFAULT_SETTINGS,
					runtimeMode: "foreground" as const,
				},
			);
			assert.equal(outcome.kind, "foreground");
		}
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

test("foreground children hide background lifecycle controls", async () => {
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
				runtimeMode: "foreground" as const,
			},
		);
		assert.equal(outcome.kind, "foreground");
		assert.equal(observedTools.length, 1);
		assert.ok(observedTools[0].includes("subagent"));
		assert.ok(observedTools[0].includes("subagent_fork"));
		for (const tool of [
			"send_message",
			"followup_task",
			"wait_agent",
			"interrupt_agent",
			"list_agents",
		]) {
			assert.ok(!observedTools[0].includes(tool));
		}
		const staleDefinitions = coordinator.createChildToolDefinitions(
			() => {
				throw new Error("activation should not be read");
			},
			"foreground",
		);
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
				const tool = getCurrentTools(context.messages).find((candidate) => candidate.name === name);
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
			},
			{ ...DEFAULT_SETTINGS, runtimeMode: "foreground" as const },
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
			},
			{ ...DEFAULT_SETTINGS, runtimeMode: "foreground" as const },
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
			},
			{
				...DEFAULT_SETTINGS,
				runtimeMode: "foreground" as const,
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
