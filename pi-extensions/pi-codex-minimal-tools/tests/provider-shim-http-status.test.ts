import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import {
	buildWebSearchStatusText,
	extractWebSearchProgress,
	mergeWebSearchActivity,
	registerOpenAIResponsesProviders,
	requestOpenAINativeCompaction,
	WEB_SEARCH_ACTIVITY_MESSAGE_TYPE,
	withHttpStatusPrefix,
	withResponsesLiteWebSocketMetadata,
} from "../src/provider-shim.js";

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;

interface FetchFactory {
	(): Response;
}

afterEach(() => {
	globalThis.fetch = originalFetch;
	globalThis.setTimeout = originalSetTimeout;
	if (originalPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
});

function installImmediateRetryTimers(): void {
	globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
		if (delay === 20_000) return 0 as unknown as ReturnType<typeof setTimeout>;
		queueMicrotask(() => {
			if (typeof callback === "function") {
				callback(...args);
			}
		});
		return 0 as unknown as ReturnType<typeof setTimeout>;
	}) as unknown as typeof setTimeout;
}

function codexJwt(): string {
	const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_test" } })).toString("base64");
	return `header.${payload}.signature`;
}

function createProviderHarness(): {
	providers: Record<string, any>;
	handlers: Record<string, Function[]>;
	messages: any[];
	renderers: Record<string, Function>;
} {
	const providers: Record<string, any> = {};
	const handlers: Record<string, Function[]> = {};
	const messages: any[] = [];
	const renderers: Record<string, Function> = {};
	const pi = {
		registerProvider(name: string, value: any) {
			providers[name] = value;
		},
		on(event: string, handler: Function) { (handlers[event] ??= []).push(handler); },
		registerMessageRenderer(type: string, renderer: Function) { renderers[type] = renderer; },
		sendMessage(message: any, options: any) { messages.push({ message, options }); },
	};
	registerOpenAIResponsesProviders(pi as any, { getCurrentCwd: () => process.cwd() });
	assert.ok(providers["openai-codex"]);
	assert.ok(providers.openai);
	return { providers, handlers, messages, renderers };
}

function createCodexProvider(): any {
	return createProviderHarness().providers["openai-codex"];
}

function mockFetch(factories: FetchFactory[]): () => number {
	let calls = 0;
	globalThis.fetch = (async () => {
		const factory = factories[Math.min(calls, factories.length - 1)];
		calls++;
		return factory();
	}) as typeof fetch;
	return () => calls;
}

async function runCodexProvider(
	streamOptions: Record<string, unknown> = {},
	modelOverrides: Record<string, unknown> = {},
	tools: any[] = [],
	contextOverrides: Record<string, unknown> = {},
): Promise<any> {
	const provider = createCodexProvider();
	const stream = provider.streamSimple(
		{
			provider: "openai-codex",
			api: "openai-codex-responses",
			id: "gpt-5.5",
			baseUrl: "https://example.test/backend-api",
			headers: {},
			input: ["text"],
			reasoning: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			...modelOverrides,
		},
		{
			systemPrompt: "",
			messages: [{ role: "user", content: "hello" }],
			tools,
			...contextOverrides,
		},
		{ apiKey: codexJwt(), transport: "sse", ...streamOptions },
	);
	return stream.result();
}

function writeSettings(value: Record<string, unknown>): void {
	const root = mkdtempSync(join(tmpdir(), "pi-codex-settings-"));
	const agentDir = join(root, "agent");
	const configDir = join(agentDir, "extensions", "pi-codex-minimal-tools");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(configDir, "config.json"), JSON.stringify(value));
	process.env.PI_CODING_AGENT_DIR = agentDir;
}

function errorResponse(status: number, body: unknown, statusText = "Error"): Response {
	return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, statusText });
}

function successSseResponse(output: unknown[] = []): Response {
	const event = {
		type: "response.completed",
		response: {
			id: "resp_ok",
			status: "completed",
			output,
			usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0 } },
		},
	};
	return new Response(`data: ${JSON.stringify(event)}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function customApplyPatchSseResponse(): Response {
	const patch = "*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch\n";
	const events = [
		{ type: "response.created", response: { id: "resp_custom" } },
		{ type: "response.output_item.added", output_index: 0, item: { type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "apply_patch", input: "" } },
		{ type: "response.custom_tool_call_input.delta", item_id: "ctc_1", call_id: "call_1", delta: "*** Begin Patch\n" },
		{ type: "response.custom_tool_call_input.delta", item_id: "ctc_1", call_id: "call_1", delta: "*** Add File: a.txt\n+x\n*** End Patch\n" },
		{ type: "response.output_item.done", output_index: 0, item: { type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "apply_patch", input: patch } },
		{ type: "response.completed", response: { id: "resp_custom", status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0 } } } },
	];
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function webSearchLifecycleSseResponse(options?: { includeDoneItem?: boolean }): Response {
	const includeDoneItem = options?.includeDoneItem ?? true;
	const completedItem = {
		type: "web_search_call",
		id: "ws_123",
		status: "completed",
		action: {
			type: "search",
			query: "latest docs",
			sources: [{ title: "Docs", url: "https://example.com/docs" }],
		},
	};
	const events = [
		{ type: "response.created", response: { id: "resp_web" } },
		{ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_123", summary: [] } },
		{ type: "response.reasoning_summary_part.added", output_index: 0, summary_index: 0, part: { type: "summary_text", text: "" } },
		{ type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 0, delta: "Need current information" },
		{ type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_123", summary: [{ type: "summary_text", text: "Need current information" }] } },
		{ type: "response.output_item.added", output_index: 1, item: { type: "web_search_call", id: "ws_123", status: "in_progress" } },
		{ type: "response.web_search_call.in_progress", item_id: "ws_123", output_index: 1, sequence_number: 5 },
		{ type: "response.web_search_call.searching", item_id: "ws_123", output_index: 1, sequence_number: 6 },
		{ type: "response.web_search_call.completed", item_id: "ws_123", output_index: 1, sequence_number: 7 },
		...(includeDoneItem ? [{ type: "response.output_item.done", output_index: 1, item: completedItem }] : []),
		{ type: "response.output_item.added", output_index: 2, item: { type: "message", id: "msg_123", role: "assistant", status: "in_progress", content: [] } },
		{ type: "response.output_text.delta", output_index: 2, content_index: 0, delta: "Final answer" },
		{ type: "response.output_item.done", output_index: 2, item: { type: "message", id: "msg_123", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Final answer", annotations: [] }] } },
		{
			type: "response.completed",
			response: {
				id: "resp_web",
				status: "completed",
				output: includeDoneItem ? [completedItem] : [],
				usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0 } },
			},
		},
	];
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function enableApiKeyMode(): void {
	writeSettings({ apiKeyMode: true });
}

test("withHttpStatusPrefix adds status once", () => {
	assert.equal(withHttpStatusPrefix(503, "Service unavailable"), "HTTP 503: Service unavailable");
	assert.equal(withHttpStatusPrefix(429, "HTTP 429: Too many requests"), "HTTP 429: Too many requests");
	assert.equal(withHttpStatusPrefix(503, "HTTP 503 upstream unavailable"), "HTTP 503 upstream unavailable");
});

test("final HTTP 429 provider failure preserves friendly usage-limit text after status prefix", async () => {
	installImmediateRetryTimers();
	const fetchCalls = mockFetch([
		() => errorResponse(429, { error: { code: "usage_limit_reached", plan_type: "PLUS", message: "Upstream quota body" } }, "Too Many Requests"),
	]);

	const result = await runCodexProvider();

	assert.equal(fetchCalls(), 4);
	assert.equal(result.stopReason, "error");
	assert.equal(result.errorMessage, "HTTP 429: You have hit your ChatGPT usage limit (plus plan).");
});

test("final HTTP 503 provider failure preserves HTTP status prefix", async () => {
	installImmediateRetryTimers();
	const fetchCalls = mockFetch([
		() => errorResponse(503, { error: { code: "server_error", message: "Service unavailable" } }, "Service Unavailable"),
	]);

	const result = await runCodexProvider();

	assert.equal(fetchCalls(), 4);
	assert.equal(result.stopReason, "error");
	assert.equal(result.errorMessage, "HTTP 503: Service unavailable");
});

test("successful SSE retry hides intermediate HTTP failure", async () => {
	installImmediateRetryTimers();
	const fetchCalls = mockFetch([
		() => errorResponse(503, { error: { code: "server_error", message: "Service unavailable" } }, "Service Unavailable"),
		() => successSseResponse(),
	]);

	const result = await runCodexProvider();

	assert.equal(fetchCalls(), 2);
	assert.equal(result.stopReason, "stop");
	assert.equal(result.errorMessage, undefined);
});

test("native web_search requests include source payloads without dropping reasoning include", async () => {
	let requestBody: any;
	globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
		requestBody = JSON.parse(String(init?.body));
		return successSseResponse();
	}) as typeof fetch;

	const result = await runCodexProvider({
		onPayload: async (payload: any) => ({ ...payload, tools: [{ type: "web_search" }] }),
	});

	assert.equal(result.stopReason, "stop");
	assert.deepEqual(requestBody.tools, [{ type: "web_search" }]);
	assert.ok(requestBody.include.includes("reasoning.encrypted_content"));
	assert.ok(requestBody.include.includes("web_search_call.action.sources"));
});

test("request profile disables parallel calls while apply_patch stays a function tool", async () => {
	writeSettings({ requestProfile: { supportsParallelTools: false } });
	let requestBody: any;
	globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
		requestBody = JSON.parse(String(init?.body));
		return successSseResponse();
	}) as typeof fetch;

	const result = await runCodexProvider({}, {}, [{
		name: "apply_patch",
		description: "Apply a patch",
		parameters: {
			type: "object",
			properties: { input: { type: "string" } },
			required: ["input"],
			additionalProperties: false,
		},
	}]);

	assert.equal(result.stopReason, "stop");
	assert.equal(requestBody.parallel_tool_calls, false);
	assert.equal(requestBody.tools[0].type, "function");
	assert.equal(requestBody.tools[0].name, "apply_patch");
});

test("Standard Responses can place the system prompt in a developer message", async () => {
	writeSettings({ requestProfile: { responsesMode: "standard", systemPromptPlacement: "developer" } });
	let requestBody: any;
	globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
		requestBody = JSON.parse(String(init?.body));
		return successSseResponse();
	}) as typeof fetch;

	const result = await runCodexProvider({}, {}, [], { systemPrompt: "Pi system prompt" });

	assert.equal(result.stopReason, "stop");
	assert.equal("instructions" in requestBody, false);
	assert.deepEqual(requestBody.input[0], {
		type: "message",
		role: "developer",
		content: [{ type: "input_text", text: "Pi system prompt" }],
	});
	assert.equal(requestBody.input[1].role, "user");
});

test("custom patch transport replaces only apply_patch with the canonical freeform tool", async () => {
	writeSettings({ requestProfile: { patchTransport: "custom" } });
	let requestBody: any;
	globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
		requestBody = JSON.parse(String(init?.body));
		return customApplyPatchSseResponse();
	}) as typeof fetch;

	const result = await runCodexProvider({}, {}, [
		{
			name: "apply_patch",
			description: "Apply a patch",
			parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false },
		},
		{
			name: "read",
			description: "Read a file",
			parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
		},
	]);

	assert.equal(result.stopReason, "toolUse");
	assert.equal(requestBody.tools[0].type, "custom");
	assert.equal(requestBody.tools[0].name, "apply_patch");
	assert.match(requestBody.tools[0].description, /FREEFORM/);
	assert.equal(requestBody.tools[0].format.type, "grammar");
	assert.equal(requestBody.tools[0].format.syntax, "lark");
	assert.match(requestBody.tools[0].format.definition, /^start: begin_patch hunk\+ end_patch/);
	assert.equal("parameters" in requestBody.tools[0], false);
	assert.equal(requestBody.tools[1].type, "function");
	assert.equal(requestBody.tools[1].name, "read");
	const toolCall = result.content.find((block: any) => block.type === "toolCall");
	assert.equal(toolCall.id, "call_1|ctc_1");
	assert.deepEqual(toolCall.arguments, { input: "*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch\n" });
});

test("Responses Lite carries custom apply_patch and replays custom history in input", async () => {
	writeSettings({ requestProfile: { responsesMode: "lite", patchTransport: "custom" } });
	let requestBody: any;
	let requestHeaders: Headers | undefined;
	globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
		requestBody = JSON.parse(String(init?.body));
		requestHeaders = new Headers(init?.headers as HeadersInit);
		return successSseResponse();
	}) as typeof fetch;

	const result = await runCodexProvider(
		{},
		{ input: ["text", "image"] },
		[{
			name: "apply_patch",
			description: "Apply a patch",
			parameters: {
				type: "object",
				properties: { input: { type: "string" } },
				required: ["input"],
				additionalProperties: false,
			},
		}],
		{
			systemPrompt: "stable instructions",
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "inspect this" },
						{ type: "image", data: "AA==", mimeType: "image/png" },
					],
					timestamp: 1,
				},
				{
					role: "assistant",
					api: "openai-codex-responses",
					provider: "openai-codex",
					model: "gpt-5.5",
					content: [{ type: "toolCall", id: "call_patch|ctc_patch", name: "apply_patch", arguments: { input: "*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch\n" } }],
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "toolUse",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "call_patch|ctc_patch",
					toolName: "apply_patch",
					content: [{ type: "text", text: "Applied patch" }],
					isError: false,
					timestamp: 3,
				},
			],
		},
	);

	assert.equal(result.stopReason, "stop");
	assert.equal("instructions" in requestBody, false);
	assert.equal("tools" in requestBody, false);
	assert.equal(requestBody.parallel_tool_calls, false);
	assert.deepEqual(requestBody.reasoning, { context: "all_turns" });
	assert.equal(requestBody.client_metadata?.ws_request_header_x_openai_internal_codex_responses_lite, undefined);
	assert.equal(requestHeaders?.get("x-openai-internal-codex-responses-lite"), "true");
	assert.equal(requestBody.input[0].type, "additional_tools");
	assert.equal(requestBody.input[0].role, "developer");
	assert.equal(requestBody.input[0].tools[0].type, "custom");
	assert.equal(requestBody.input[0].tools[0].name, "apply_patch");
	assert.equal(requestBody.input[0].tools[0].format.syntax, "lark");
	assert.deepEqual(requestBody.input[1], {
		type: "message",
		role: "developer",
		content: [{ type: "input_text", text: "stable instructions" }],
	});
	const image = requestBody.input[2].content.find((item: any) => item.type === "input_image");
	assert.ok(image);
	assert.equal("detail" in image, false);
	assert.equal(requestBody.input[3].type, "custom_tool_call");
	assert.equal(requestBody.input[3].name, "apply_patch");
	assert.match(requestBody.input[3].input, /^\*\*\* Begin Patch/);
	assert.equal(requestBody.input[4].type, "custom_tool_call_output");
	assert.equal(requestBody.input[4].call_id, "call_patch");
	assert.equal(requestBody.input[4].output, "Applied patch");
});

test("Responses Lite adds its WebSocket signal only to WebSocket client metadata", () => {
	const body = { client_metadata: { existing: "value" } };
	assert.equal(withResponsesLiteWebSocketMetadata(body, "standard"), body);
	assert.deepEqual(withResponsesLiteWebSocketMetadata(body, "lite"), {
		client_metadata: {
			existing: "value",
			ws_request_header_x_openai_internal_codex_responses_lite: "true",
		},
	});
});

test("web search special events merge with output items into one rendered activity", async () => {
	const harness = createProviderHarness();
	globalThis.fetch = (async () => webSearchLifecycleSseResponse()) as typeof fetch;

	const stream = harness.providers["openai-codex"].streamSimple(
		{
			provider: "openai-codex",
			api: "openai-codex-responses",
			id: "gpt-5.5",
			baseUrl: "https://example.test/backend-api",
			headers: {},
			input: ["text"],
			reasoning: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		},
		{ systemPrompt: "", messages: [{ role: "user", content: "hello" }], tools: [] },
		{ apiKey: codexJwt(), transport: "sse" },
	);
	const updates: Array<{ type: string; content: any[] }> = [];
	for await (const event of stream) {
		if ("partial" in event) {
			updates.push({
				type: event.type,
				content: event.partial.content.map((block: any) => ({ ...block })),
			});
		}
	}
	const result = await stream.result();
	for (const handler of harness.handlers.agent_end ?? []) await handler({});
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.equal(result.stopReason, "stop");
	assert.equal(harness.messages.length, 0, "web search activity must not wait in pi.sendMessage's steer queue");
	assert.deepEqual(result.content.map((block: any) => block.type), ["thinking", "text", "text"]);
	assert.match((result.content[1] as any).text, /Searched the web.*latest docs/);
	assert.match((result.content[1] as any).textSignature, /^pi:web-search-activity:ws_123/);
	assert.equal((result.content[2] as any).text, "Final answer");
	const searchUpdateIndex = updates.findIndex((update) =>
		update.content.some((block) => block.type === "text" && /Searching the web|Searched the web/.test(block.text)));
	const finalAnswerUpdateIndex = updates.findIndex((update) =>
		update.content.some((block) => block.type === "text" && block.text === "Final answer"));
	assert.ok(searchUpdateIndex >= 0);
	assert.ok(finalAnswerUpdateIndex > searchUpdateIndex, "web search activity should render before the final reply");

	const theme = {
		bg(_color: string, text: string) { return text; },
		fg(_color: string, text: string) { return text; },
		bold(text: string) { return text; },
	};
	const component = harness.renderers[WEB_SEARCH_ACTIVITY_MESSAGE_TYPE]({
		content: "legacy activity",
		details: {
			searches: [{
				callId: "ws_123",
				status: "completed",
				completed: true,
				query: "latest docs",
				queries: [],
				sources: [],
			}],
		},
	}, { expanded: false }, theme);
	assert.match(component.render(120).join("\n"), /Searched the web for latest docs/);
});

test("web search special events render even when no output item is returned", async () => {
	const harness = createProviderHarness();
	globalThis.fetch = (async () => webSearchLifecycleSseResponse({ includeDoneItem: false })) as typeof fetch;

	const stream = harness.providers.openai.streamSimple(
		{
			provider: "openai",
			api: "openai-responses",
			id: "gpt-5.5",
			baseUrl: "https://example.test/v1",
			headers: {},
			input: ["text"],
			reasoning: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		},
		{ systemPrompt: "", messages: [{ role: "user", content: "hello" }], tools: [] },
		{ apiKey: "plain-api-key", transport: "sse" },
	);
	const result = await stream.result();
	for (const handler of harness.handlers.agent_end ?? []) await handler({});
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.equal(result.stopReason, "stop");
	assert.equal(harness.messages.length, 0);
	const activity = result.content.find((block: any) => block.type === "text" && block.textSignature?.startsWith("pi:web-search-activity:"));
	assert.ok(activity);
	assert.match(activity.text, /Searched the web/);
});

test("web search progress parsing and action merging preserve authoritative detail", () => {
	const progress = extractWebSearchProgress({
		type: "response.web_search_call.searching",
		item_id: "ws_1",
		output_index: 2,
	});
	assert.deepEqual(progress, {
		callId: "ws_1",
		status: "searching",
		completed: false,
		queries: [],
		sources: [],
	});

	const merged = mergeWebSearchActivity(progress, {
		callId: "ws_1",
		status: "completed",
		completed: true,
		actionType: "find_in_page",
		queries: [],
		url: "https://example.com/docs",
		pattern: "streaming",
		sources: [{ title: "Docs", url: "https://example.com/docs" }],
	});
	assert.equal(buildWebSearchStatusText(merged), "Searched the web for 'streaming' in https://example.com/docs");
	assert.equal(merged.sources.length, 1);
});

test("openai provider applies request profiles with API-key Responses transport", async () => {
	writeSettings({ requestProfile: { patchTransport: "custom", supportsParallelTools: false } });
	const provider = createProviderHarness().providers.openai;
	let requestUrl = "";
	let requestBody: any;
	let accountHeader: string | null = null;
	globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
		requestUrl = String(url);
		requestBody = JSON.parse(String(init?.body));
		accountHeader = new Headers(init?.headers as HeadersInit).get("chatgpt-account-id");
		return successSseResponse();
	}) as typeof fetch;

	const stream = provider.streamSimple(
		{
			provider: "openai",
			api: "openai-responses",
			id: "gpt-5.5",
			baseUrl: "https://example.test/v1",
			headers: {},
			input: ["text"],
			reasoning: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		},
		{
			systemPrompt: "",
			messages: [{ role: "user", content: "hello" }],
			tools: [{
				name: "apply_patch",
				description: "Apply a patch",
				parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false },
			}],
		},
		{ apiKey: "plain-api-key" },
	);
	const result = await stream.result();

	assert.equal(result.stopReason, "stop");
	assert.equal(result.api, "openai-responses");
	assert.equal(requestUrl, "https://example.test/v1/responses");
	assert.equal(accountHeader, null);
	assert.equal(requestBody.parallel_tool_calls, false);
	assert.equal(requestBody.tools[0].type, "custom");
	assert.equal(requestBody.tools[0].name, "apply_patch");
});

test("openai GPT-5 requests can opt into Responses context_management", async () => {
	writeSettings({
		compactionMode: "responses-context-management",
		nativeCompactionThreshold: 123_456,
	});
	const provider = createProviderHarness().providers.openai;
	let requestBody: any;
	globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
		requestBody = JSON.parse(String(init?.body));
		return successSseResponse();
	}) as typeof fetch;

	const stream = provider.streamSimple(
		{
			provider: "openai",
			api: "openai-responses",
			id: "gpt-5.5",
			baseUrl: "https://example.test/v1",
			headers: {},
			input: ["text"],
			reasoning: false,
			contextWindow: 400_000,
			maxTokens: 16_384,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		},
		{ systemPrompt: "", messages: [{ role: "user", content: "hello" }], tools: [] },
		{ apiKey: "plain-api-key" },
	);
	const result = await stream.result();

	assert.equal(result.stopReason, "stop");
	assert.deepEqual(requestBody.context_management, [{
		type: "compaction",
		compact_threshold: 123_456,
	}]);
});

test("native compaction supports /responses context_management and /responses/compact", async () => {
	const model = {
		provider: "openai",
		api: "openai-responses",
		id: "gpt-5.5",
		baseUrl: "https://example.test/v1",
		headers: {},
		input: ["text"],
		reasoning: false,
		contextWindow: 400_000,
		maxTokens: 16_384,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} as any;
	const context = {
		systemPrompt: "system",
		messages: [{ role: "user", content: "hello", timestamp: 1 }],
		tools: [],
	} as any;
	const settings = {
		enabled: true,
		glyphStyle: "unicode",
		autoEnable: true,
		nativeProviderTools: true,
		compactionMode: "responses-context-management",
		nativeCompactionThreshold: 0,
		requestProfile: {},
		apiKeyMode: false,
		imageGeneration: true,
		webSearchEnabled: false,
		imageOutputDir: ".pi/openai-codex-images",
		imageModel: "gpt-image-2",
		directImageApiFallback: false,
		viewImage: false,
		viewImageWorkspaceOnly: false,
		applyPatchEnabled: true,
		allowAbsolutePatchPaths: false,
		deferApplyPatchRendering: false,
	} as const;
	const requests: Array<{ url: string; body: any }> = [];
	globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body));
		requests.push({ url: String(url), body });
		if (String(url).endsWith("/responses/compact")) {
			return Response.json({
				output: [
					{ type: "message", role: "user", content: [{ type: "input_text", text: "retained" }] },
					{ type: "compaction", encrypted_content: "legacy-encrypted" },
				],
			});
		}
		return Response.json({
			output: [{ type: "compaction", encrypted_content: "managed-encrypted" }],
		});
	}) as typeof fetch;

	const managed = await requestOpenAINativeCompaction(model, context, {
		mode: "responses-context-management",
		apiKey: "key",
		settings: settings as any,
	});
	const legacy = await requestOpenAINativeCompaction(model, context, {
		mode: "responses-compact",
		apiKey: "key",
		settings: { ...settings, compactionMode: "responses-compact" } as any,
	});

	assert.deepEqual(managed, [{ type: "compaction", encrypted_content: "managed-encrypted" }]);
	assert.equal(requests[0]?.url, "https://example.test/v1/responses");
	assert.equal(requests[0]?.body.stream, false);
	assert.deepEqual(requests[0]?.body.context_management, [{ type: "compaction", compact_threshold: 1 }]);
	assert.equal(requests[1]?.url, "https://example.test/v1/responses/compact");
	assert.equal("stream" in requests[1]!.body, false);
	assert.equal("store" in requests[1]!.body, false);
	assert.equal("include" in requests[1]!.body, false);
	assert.deepEqual(legacy, [
		{ type: "message", role: "user", content: [{ type: "input_text", text: "retained" }] },
		{ type: "compaction", encrypted_content: "legacy-encrypted" },
	]);
});

test("apiKeyMode accepts plain API keys without account-id extraction", async () => {
	enableApiKeyMode();
	let authHeader: string | null = null;
	let accountHeader: string | null = null;
	globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
		const headers = new Headers(init?.headers as HeadersInit);
		authHeader = headers.get("authorization");
		accountHeader = headers.get("chatgpt-account-id");
		return successSseResponse();
	}) as typeof fetch;

	const result = await runCodexProvider({ apiKey: "plain-api-key" });

	assert.equal(result.stopReason, "stop");
	assert.equal(authHeader, "Bearer plain-api-key");
	assert.equal(accountHeader, null);
});

test("apiKeyMode treats /responses baseUrl as complete endpoint", async () => {
	enableApiKeyMode();
	let requestedUrl = "";
	globalThis.fetch = (async (url: RequestInfo | URL) => {
		requestedUrl = String(url);
		return successSseResponse();
	}) as typeof fetch;

	const result = await runCodexProvider({ apiKey: "plain-api-key" }, { baseUrl: "https://example.test/v1/responses" });

	assert.equal(result.stopReason, "stop");
	assert.equal(requestedUrl, "https://example.test/v1/responses");
});

test("SSE response-header timeout uses configured stream timeout", async () => {
	installImmediateRetryTimers();
	globalThis.fetch = ((_url: RequestInfo | URL, init?: RequestInit) =>
		new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject((init.signal as AbortSignal).reason), { once: true });
		})) as typeof fetch;

	const result = await runCodexProvider({ timeoutMs: 1 });

	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage, /Codex Responses SSE response headers timed out after 1ms/);
	assert.doesNotMatch(result.errorMessage, /20000ms/);
});
