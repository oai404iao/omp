import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { registerOpenAICodexCustomProvider, WEB_SEARCH_ACTIVITY_MESSAGE_TYPE, withHttpStatusPrefix, withResponsesLiteWebSocketMetadata } from "../src/provider-shim.js";

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

function createCodexProviderHarness(): { provider: any; handlers: Record<string, Function[]>; messages: any[] } {
	let provider: any;
	const handlers: Record<string, Function[]> = {};
	const messages: any[] = [];
	const pi = {
		registerProvider(name: string, value: any) {
			assert.equal(name, "openai-codex");
			provider = value;
		},
		on(event: string, handler: Function) { (handlers[event] ??= []).push(handler); },
		registerMessageRenderer() {},
		sendMessage(message: any, options: any) { messages.push({ message, options }); },
	};
	registerOpenAICodexCustomProvider(pi as any, { getCurrentCwd: () => process.cwd() });
	assert.ok(provider);
	return { provider, handlers, messages };
}

function createCodexProvider(): any {
	return createCodexProviderHarness().provider;
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

test("web_search_call activity is emitted through pending provider messages", async () => {
	const harness = createCodexProviderHarness();
	globalThis.fetch = (async () => successSseResponse([
		{
			type: "web_search_call",
			id: "ws_123",
			status: "completed",
			action: { query: "latest docs", sources: [{ title: "Docs", url: "https://example.com/docs" }] },
		},
	])) as typeof fetch;

	const stream = harness.provider.streamSimple(
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
	const result = await stream.result();
	for (const handler of harness.handlers.agent_end ?? []) await handler({});
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.equal(result.stopReason, "stop");
	assert.equal(harness.messages.length, 1);
	assert.equal(harness.messages[0].message.customType, WEB_SEARCH_ACTIVITY_MESSAGE_TYPE);
	assert.equal(harness.messages[0].options.triggerTurn, false);
	assert.match(harness.messages[0].message.content, /Call: ws_123 \(completed\)/);
	assert.match(harness.messages[0].message.content, /Docs: https:\/\/example\.com\/docs/);
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
