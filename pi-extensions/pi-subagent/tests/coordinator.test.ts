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
import { CODEX_IDENTITY_CUSTOM_TYPE } from "@oai404iao/pi-codex-minimal-tools/subagent-inline";
import { DEFAULT_SETTINGS } from "../src/config.ts";
import { SubagentCoordinator, AGENT_CUSTOM_TYPE } from "../src/coordinator.ts";
import { foldDescriptor } from "../src/descriptor.ts";

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
	return { coordinator, parent, messages, events, eventDetails, agentDir };
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
				run_in_background: false,
			},
			{ ...DEFAULT_SETTINGS, defaultBackground: false },
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
				run_in_background: false,
			},
			{
				...DEFAULT_SETTINGS,
				defaultBackground: false,
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
				run_in_background: false,
			},
			{ ...DEFAULT_SETTINGS, defaultBackground: false, openAIIdentity: false },
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
				run_in_background: false,
			},
			{ ...DEFAULT_SETTINGS, defaultBackground: false },
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
		const id = outcome.details.agentId;
		const firstList = await coordinator.list(parent, "children");
		assert.equal(firstList[0]?.kind, "child");
		if (firstList[0]?.kind === "child") {
			assert.equal(firstList[0].status, "ready");
			assert.equal(firstList[0].agentId, id);
			assert.equal(firstList[0].parentAgentId, parent.agentId);
		}

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
				run_in_background: true,
			},
			{ ...DEFAULT_SETTINGS, defaultBackground: true },
		);
		assert.equal(outcome.kind, "continuable");
		await waitUntil(() => messages.length === 1);

		await Promise.all([
			coordinator.sendMessage(parent, outcome.details.agentId, "First follow-up."),
			coordinator.sendMessage(parent, outcome.details.agentId, "Second follow-up."),
		]);
		await waitUntil(() => messages.length === 2);
		assert.deepEqual(events, [
			"pi-subagent:start",
			"pi-subagent:end",
			"pi-subagent:start",
			"pi-subagent:end",
		]);
		assert.match(messages[1]!.content, /child answer 3/);
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
				run_in_background: true,
			},
			{ ...DEFAULT_SETTINGS, defaultBackground: true },
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
		await waitUntil(() => requests === 2);
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

test("a follow-up waits behind an internally queued wakeup", async () => {
	const { coordinator, parent } = await fixture({ delayMs: 50 });
	try {
		coordinator.configureBackgroundRuns(1);
		const settings = {
			...DEFAULT_SETTINGS,
			defaultBackground: true,
			maxConcurrentBackgroundRuns: 1,
		};
		const waiting = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "internal wakeup target",
				prompt: "Finish while retaining a descendant.",
				run_in_background: true,
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
					}
				>;
				startInternalMessage(
					activation: unknown,
					customType: string,
					content: string,
					details: {
						kind: "settled";
						childAgentId: string;
						label: string;
						stopReason: "completed";
					},
				): void;
			}
		);
		const target = active.active.get(waiting.details.agentId);
		assert.ok(target);
		target.ownedChildren.add("test-descendant");
		await target.currentRun;

		const holder = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "internal wakeup capacity holder",
				prompt: "Hold the only slot.",
				run_in_background: true,
			},
			settings,
		);
		assert.equal(holder.kind, "continuable");

		active.startInternalMessage(
			target,
			"pi-subagent/settled",
			"A descendant completed.",
			{
				kind: "settled",
				childAgentId: "test-descendant",
				label: "test descendant",
				stopReason: "completed",
			},
		);
		await coordinator.sendMessage(
			parent,
			waiting.details.agentId,
			"Follow the internal wakeup without failing.",
		);
		await waitUntil(() => target.currentRun === undefined);
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
			defaultBackground: true,
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
						run_in_background: true,
					},
					settings,
				),
			),
		);
		assert.equal(
			outcomes.every((outcome) => outcome.kind === "continuable"),
			true,
		);
		await waitUntil(() => messages.length === 3);
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
			defaultBackground: true,
			maxConcurrentBackgroundRuns: 1,
		};
		const first = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "capacity holder",
				prompt: "Hold the only background slot.",
				run_in_background: true,
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
				run_in_background: true,
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
		await waitUntil(() => messages.length === 1);
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

test("interrupt cancels a cold follow-up while it waits for capacity", async () => {
	const { coordinator, parent, messages } = await fixture({ delayMs: 100 });
	try {
		coordinator.configureBackgroundRuns(4);
		const initial = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "cold follow-up target",
				prompt: "Create the durable target.",
				run_in_background: true,
			},
			{
				...DEFAULT_SETTINGS,
				defaultBackground: true,
				maxConcurrentBackgroundRuns: 4,
			},
		);
		assert.equal(initial.kind, "continuable");
		await waitUntil(() => messages.length === 1);
		coordinator.configureBackgroundRuns(1);

		const holder = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "follow-up capacity holder",
				prompt: "Hold the only slot.",
				run_in_background: true,
			},
			{
				...DEFAULT_SETTINGS,
				defaultBackground: true,
				maxConcurrentBackgroundRuns: 1,
			},
		);
		assert.equal(holder.kind, "continuable");

		const firstFollowUp = coordinator.sendMessage(
			parent,
			initial.details.agentId,
			"Queue the first cold follow-up.",
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
		const secondController = new AbortController();
		const secondFollowUp = coordinator.sendMessage(
			parent,
			initial.details.agentId,
			"Queue the second cold follow-up behind the first.",
			secondController.signal,
		);
		secondController.abort(new Error("cancel second follow-up"));
		await assert.rejects(secondFollowUp, /cancel second follow-up/);
		await coordinator.interrupt(parent, initial.details.agentId);
		await assert.rejects(firstFollowUp, /was interrupted/);
		await waitUntil(() => messages.length === 2);
	} finally {
		await coordinator.shutdown();
	}
});

test("interrupting a queued resident follow-up does not suppress later settlement", async () => {
	const { coordinator, parent, messages } = await fixture({ delayMs: 60 });
	try {
		coordinator.configureBackgroundRuns(1);
		const settings = {
			...DEFAULT_SETTINGS,
			defaultBackground: true,
			maxConcurrentBackgroundRuns: 1,
		};
		const waiting = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "resident waiting child",
				prompt: "Finish while retaining a descendant.",
				run_in_background: true,
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
				run_in_background: true,
			},
			settings,
		);
		assert.equal(holder.kind, "continuable");

		const interrupted = coordinator.sendMessage(
			parent,
			waiting.details.agentId,
			"Queue this resident follow-up.",
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

		await waitUntil(() => messages.length === 1);
		await coordinator.sendMessage(
			parent,
			waiting.details.agentId,
			"Run successfully after the interruption.",
		);
		await waitUntil(() => active.currentRun === undefined);
		active.ownedChildren.delete("test-descendant");
		await (
			coordinator as unknown as {
				finalizeContinuable(activation: unknown): Promise<void>;
			}
		).finalizeContinuable(active);
		await waitUntil(() => messages.length === 2);
		assert.match(messages[1]!.content, /finished/);
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
				run_in_background: true,
			},
			{ ...DEFAULT_SETTINGS, defaultBackground: true },
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
			run_in_background: false,
		},
		{ ...DEFAULT_SETTINGS, defaultBackground: false },
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
		await coordinator.interrupt(parent, outcome.details.agentId);
		await waitUntil(() => messages.length === 1);
		assert.match(messages[0].content, /was interrupted/);
		const entries = await coordinator.list(parent, "children");
		assert.equal(entries[0]?.kind, "child");
		if (entries[0]?.kind === "child") assert.equal(entries[0].status, "ready");
	} finally {
		await coordinator.shutdown();
	}
});

test("agent ids are a durable namespace distinct from pi session ids", async () => {
	const { coordinator, parent, messages } = await fixture();
	try {
		const outcome = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "id semantics scout",
				prompt: "Inspect it.",
				run_in_background: true,
			},
			{ ...DEFAULT_SETTINGS, defaultBackground: true },
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
		await waitUntil(() => messages.length === 1);

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
	const { coordinator, parent, messages } = await fixture();
	try {
		const outcome = await coordinator.delegate(
			parent,
			"spawn",
			{
				agent: "scout",
				description: "resumable scout",
				prompt: "Inspect it.",
				run_in_background: true,
			},
			{ ...DEFAULT_SETTINGS, defaultBackground: true },
		);
		assert.equal(outcome.kind, "continuable");
		if (outcome.kind !== "continuable") return;
		const agentId = outcome.details.agentId;
		await waitUntil(() => messages.length === 1);

		await coordinator.sendMessage(parent, agentId, "Inspect one more thing.");
		await waitUntil(() => messages.length === 2);
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
			{ ...DEFAULT_SETTINGS, defaultBackground: false },
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
