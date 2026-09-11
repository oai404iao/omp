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
} from "@earendil-works/pi-coding-agent";
import {
	createAssistantMessageEventStream,
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

async function harness(): Promise<Harness> {
	const root = tempRoot();
	const agentDir = join(root, "agent");
	const cwd = join(root, "cwd");
	mkdirSync(cwd, { recursive: true });
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
	assert.equal(fixture.contexts[0].messages.at(-1)?.role, "toolResult");
	assert.equal(fixture.session.messages.at(-1)?.role, "assistant");

	const appended = fixture.session.sessionManager.getEntries().slice(entriesBefore);
	assert.deepEqual(
		appended.map((entry) => (entry.type === "message" ? entry.message.role : entry.type)),
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
	assert.equal(fixture.contexts[0].messages.at(-1)?.role, "toolResult");
	assert.equal(fixture.session.messages.at(-1)?.role, "assistant");

	const continuation = fixture.session.sessionManager.getEntries().at(-1);
	assert.equal(continuation?.type, "message");
	assert.equal(continuation?.type === "message" ? continuation.parentId : undefined, toolResultId);
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
	assert.equal(fixture.contexts[0].messages.at(-1)?.role, "toolResult");

	const continuation = fixture.session.sessionManager.getEntries().at(-1);
	assert.equal(continuation?.type, "message");
	assert.equal(continuation?.type === "message" ? continuation.parentId : undefined, toolResultId);
});
