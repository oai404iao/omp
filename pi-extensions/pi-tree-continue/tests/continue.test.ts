import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ExtensionCommandContextActions,
	type ExtensionUIContext,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
	createAssistantMessageEventStream,
	getCurrentSystemPrompt,
	getCurrentTools,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type ToolCall,
} from "@earendil-works/pi-ai";

const roots: string[] = [];

after(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-tree-continue-"));
	roots.push(root);
	return root;
}

function usage() {
	return {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function textStream(model: Model<any>, text: string): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const partial: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: usage(),
			stopReason: "pending",
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial });
		partial.content = [{ type: "text", text }];
		stream.push({ type: "text_start", contentIndex: 0, partial });
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial });
		stream.push({ type: "done", reason: "stop", message: { ...partial, stopReason: "stop" } });
		stream.end();
	});
	return stream;
}

interface Harness {
	session: AgentSession;
	model: Model<any>;
	contexts: Context[];
	notifications: Array<{ message: string; type: string | undefined }>;
}

async function harness(options: { failRequest?: () => boolean; factory?: ExtensionFactory } = {}): Promise<Harness> {
	const root = tempRoot();
	const agentDir = join(root, "agent");
	const cwd = join(root, "cwd");
	mkdirSync(cwd, { recursive: true });
	const settingsManager = SettingsManager.inMemory({
		retry: { enabled: true, maxRetries: 2, baseDelayMs: 50 },
	});
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		additionalExtensionPaths: [join(resolve(import.meta.dirname, ".."), "index.ts")],
		extensionFactories: options.factory ? [options.factory] : [],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);

	const contexts: Context[] = [];
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
	});
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
		streamSimple: (model, context) => {
			contexts.push(context);
			if (options.failRequest?.()) {
				const stream = createAssistantMessageEventStream();
				const message: AssistantMessage = {
					role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
					usage: usage(), stopReason: "error", errorMessage: "503 service unavailable", timestamp: Date.now(),
				};
				queueMicrotask(() => { stream.push({ type: "error", reason: "error", error: message }); stream.end(); });
				return stream;
			}
			return textStream(model, `continued ${contexts.length}`);
		},
	});
	const model = modelRuntime.getModel("scripted", "echo");
	assert.ok(model);

	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model,
		modelRuntime,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
		resourceLoader: loader,
	});
	const notifications: Harness["notifications"] = [];
	const commandContextActions: ExtensionCommandContextActions = {
		waitForIdle: () => session.waitForIdle(),
		newSession: async () => ({ cancelled: true }),
		fork: async () => ({ cancelled: true }),
		navigateTree: async (targetId, options) => session.navigateTree(targetId, options),
		switchSession: async () => ({ cancelled: true }),
		reload: async () => {},
	};
	await session.bindExtensions({
		mode: "print",
		commandContextActions,
		uiContext: {
			notify: (message: string, type?: string) => notifications.push({ message, type }),
		} as unknown as ExtensionUIContext,
	});
	return { session, model, contexts, notifications };
}

/** Seed a completed turn that ends at a toolResult, then move the leaf to it. */
function seedToolResultTurn(harness: Harness, trailing?: string): string {
	const { session, model } = harness;
	const manager = session.sessionManager;
	manager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "run the tool" }],
		timestamp: Date.now(),
	});
	const toolCall: ToolCall = {
		type: "toolCall",
		id: "call-1",
		name: "read",
		arguments: { path: "seed.txt" },
	};
	manager.appendMessage({
		role: "assistant",
		content: [toolCall],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: usage(),
		stopReason: "toolUse",
		timestamp: Date.now(),
	});
	const toolResultId = manager.appendMessage({
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: [{ type: "text", text: "seed result" }],
		isError: false,
		timestamp: Date.now(),
	});
	// A label moves the leaf past the toolResult so navigateTree rebuilds agent state.
	manager.appendLabelChange(toolResultId, "seed");
	if (trailing !== undefined) {
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: trailing }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: usage(),
			stopReason: "stop",
			timestamp: Date.now(),
		});
	}
	return toolResultId;
}

test("/continue resumes from a toolResult without appending a user message", async () => {
	const fixture = await harness();
	const toolResultId = seedToolResultTurn(fixture);
	const navigation = await fixture.session.navigateTree(toolResultId, { summarize: false });
	assert.equal(navigation.cancelled, false);

	const events: string[] = [];
	const unsubscribe = fixture.session.subscribe((event) => events.push(event.type));
	const entriesBefore = fixture.session.sessionManager.getEntries().length;
	await fixture.session.prompt("/continue");
	unsubscribe();

	assert.deepEqual(fixture.notifications, []);
	assert.equal(fixture.contexts.length, 1);
	assert.equal(fixture.contexts[0].messages.filter((message) => message.role !== "system").at(-1)?.role, "toolResult");
	assert.match(getCurrentSystemPrompt(fixture.contexts[0].messages), /coding assistant/i);
	assert(getCurrentTools(fixture.contexts[0].messages).some((tool) => tool.name === "read"));
	assert.equal(fixture.session.messages.at(-1)?.role, "assistant");

	const appended = fixture.session.sessionManager.getEntries().slice(entriesBefore);
	assert.deepEqual(
		appended.filter((entry) => entry.type !== "message" || entry.message.role !== "system")
			.map((entry) => (entry.type === "message" ? entry.message.role : entry.type)),
		["assistant"],
	);
	assert.equal(events.includes("agent_start"), true);
	assert.equal(events.includes("agent_settled"), true);
	assert.equal(fixture.session.isStreaming, false);
});

test("/continue skips an empty assistant error after the tool result", async () => {
	const fixture = await harness();
	const toolResultId = seedToolResultTurn(fixture);
	fixture.session.sessionManager.appendMessage({
		role: "assistant",
		content: [],
		api: fixture.model.api,
		provider: fixture.model.provider,
		model: fixture.model.id,
		usage: usage(),
		stopReason: "error",
		errorMessage: "529 overloaded",
		timestamp: Date.now(),
	});

	await fixture.session.prompt("/continue");

	assert.deepEqual(fixture.notifications, []);
	assert.equal(fixture.contexts.length, 1);
	assert.equal(fixture.contexts[0].messages.filter((message) => message.role !== "system").at(-1)?.role, "toolResult");
	assert.equal(fixture.session.messages.at(-1)?.role, "assistant");

	const continuation = fixture.session.sessionManager.getEntries().at(-1);
	assert.equal(continuation?.type, "message");
	assert(fixture.session.sessionManager.getBranch().some((entry) => entry.id === toolResultId));
	assert(!fixture.contexts[0].messages.some((message) => message.role === "assistant" && message.stopReason === "error"));
});

test("/continue refuses to abandon normal entries without --force", async () => {
	const fixture = await harness();
	seedToolResultTurn(fixture, "normal assistant answer");

	await fixture.session.prompt("/continue");

	assert.equal(fixture.contexts.length, 0);
	assert.deepEqual(fixture.notifications, [
		{
			message:
				"Current branch does not end at a tool result or empty assistant error. Use /continue --force to abandon later entries.",
			type: "warning",
		},
	]);
});

test("/continue --force rolls back to the latest toolResult", async () => {
	const fixture = await harness();
	const toolResultId = seedToolResultTurn(fixture, "normal assistant answer");

	await fixture.session.prompt("/continue --force");

	assert.deepEqual(fixture.notifications, []);
	assert.equal(fixture.contexts.length, 1);
	assert.equal(fixture.contexts[0].messages.filter((message) => message.role !== "system").at(-1)?.role, "toolResult");

	const continuation = fixture.session.sessionManager.getEntries().at(-1);
	assert.equal(continuation?.type, "message");
	assert(fixture.session.sessionManager.getBranch().some((entry) => entry.id === toolResultId));
	assert.doesNotMatch(JSON.stringify(fixture.contexts[0].messages), /normal assistant answer/);
});

test("/continue retains system updates and their tool loadout before a failed response", async () => {
	const fixture = await harness();
	seedToolResultTurn(fixture);
	fixture.session.sessionManager.appendMessage({
		role: "system", content: "", sections: { audit: "OLD_SECTION", removed: "REMOVED_SECTION" }, timestamp: Date.now(),
	});
	const updateId = fixture.session.sessionManager.appendMessage({
		role: "system", content: "TRANSCRIPT_UPDATE",
		sections: { audit: "UPDATED_SECTION", removed: null },
		toolsAdded: [{ name: "read", description: "Read", parameters: { type: "object" } }],
		timestamp: Date.now(),
	});
	fixture.session.sessionManager.appendMessage({
		role: "assistant", content: [], api: fixture.model.api, provider: fixture.model.provider,
		model: fixture.model.id, usage: usage(), stopReason: "error", errorMessage: "failed", timestamp: Date.now(),
	});
	await fixture.session.prompt("/continue");
	assert.deepEqual(fixture.notifications, []);
	assert.equal(fixture.contexts.length, 1);
	assert.match(getCurrentSystemPrompt(fixture.contexts[0].messages), /TRANSCRIPT_UPDATE/);
	assert.match(getCurrentSystemPrompt(fixture.contexts[0].messages), /UPDATED_SECTION/);
	assert.doesNotMatch(getCurrentSystemPrompt(fixture.contexts[0].messages), /OLD_SECTION|REMOVED_SECTION/);
	assert.deepEqual(getCurrentTools(fixture.contexts[0].messages).map((tool) => tool.name), ["read"]);
	assert(fixture.session.sessionManager.getBranch().some((entry) => entry.id === updateId));
	assert.equal(fixture.contexts[0].messages.filter((message) => message.role === "user").length, 1);
	assert(!fixture.contexts[0].messages.some((message) => message.role === "assistant" && message.stopReason === "error"));
});

for (const existingSystem of [false, true]) {
	test(`/continue cancellation during retry resets the run (existing system=${existingSystem})`, async () => {
		let fail = true;
		const fixture = await harness({ failRequest: () => { const value = fail; fail = false; return value; } });
		if (existingSystem) fixture.session.sessionManager.appendMessage({
			role: "system", content: "EXISTING_PROMPT", timestamp: Date.now(),
		});
		const target = seedToolResultTurn(fixture);
		await fixture.session.navigateTree(target, { summarize: false });
		let settled = 0;
		let retried = false;
		const unsubscribe = fixture.session.subscribe((event) => {
			if (event.type === "agent_settled") settled++;
			if (event.type === "auto_retry_start") {
				retried = true;
				void fixture.session.abort();
			}
		});
		await fixture.session.prompt("/continue");
		assert(retried);
		assert.equal(settled, 1);
		assert.equal(fixture.contexts.length, 1, "cancelled backoff must not dispatch a retry");
		assert.equal(fixture.session.isRetrying, false);
		await fixture.session.prompt("/continue");
		unsubscribe();
		assert.equal(settled, 2);
		assert.equal(fixture.contexts.length, 2);
		assert.equal(fixture.session.isRetrying, false);
		assert.equal(fixture.session.messages.filter((message) => message.role === "user").length, 1);
		assert.deepEqual(fixture.notifications, []);
	});
}

test("/continue settles after cancellation and can start another message-free run", async () => {
	const fixture = await harness();
	const target = seedToolResultTurn(fixture);
	await fixture.session.navigateTree(target, { summarize: false });
	const unsubscribe = fixture.session.subscribe((event) => {
		if (event.type === "agent_start") void fixture.session.abort();
	});
	await fixture.session.prompt("/continue");
	unsubscribe();
	assert.equal(fixture.session.isStreaming, false);
	await fixture.session.prompt("/continue");
	assert.deepEqual(fixture.notifications, []);
	assert.equal(fixture.session.messages.at(-1)?.role, "assistant");
	assert.equal(fixture.session.isStreaming, false);
	assert.equal(fixture.session.messages.filter((message) => message.role === "user").length, 1);
});

test("/continue restores prompt preparation before settled handlers start a new user turn", async () => {
	let started = false;
	const fixture = await harness({ factory: (pi) => {
		pi.on("before_agent_start", (event) => { event.systemPromptOptions.sections.next = "NEW_USER_SECTION"; });
		pi.on("agent_settled", async () => {
			if (started) return;
			started = true;
			await fixture.session.prompt("new user turn");
		});
	} });
	const target = seedToolResultTurn(fixture);
	await fixture.session.navigateTree(target, { summarize: false });
	await fixture.session.prompt("/continue");
	assert.deepEqual(fixture.notifications, []);
	assert.equal(fixture.contexts.length, 2);
	assert.match(getCurrentSystemPrompt(fixture.contexts[1].messages), /NEW_USER_SECTION/);
});
