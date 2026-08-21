import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { standaloneImageGeneration } from "../src/tools/image-generation.js";
import { standaloneWebSearch } from "../src/tools/web-search.js";
import { loadModelSettings } from "../src/model-catalog/runtime.js";

const originalFetch = globalThis.fetch;
const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
});

function withAgentDir<T>(fn: (agentDir: string) => Promise<T> | T): Promise<T> | T {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-codex-standalone-tools-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const cleanup = () => rmSync(agentDir, { recursive: true, force: true });
	try {
		const result = fn(agentDir);
		return result instanceof Promise ? result.finally(cleanup) : (cleanup(), result);
	} catch (error) {
		cleanup();
		throw error;
	}
}

function writeModels(agentDir: string, models: unknown[]): void {
	const dir = join(agentDir, "extensions", "pi-codex-minimal-tools");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "models.json"), JSON.stringify({ version: 1, models }));
}

function jwt(): string {
	const payload = Buffer.from(JSON.stringify({
		"https://api.openai.com/auth": { chatgpt_account_id: "acct_test" },
	})).toString("base64");
	return `header.${payload}.signature`;
}

test("standalone web search uses the Codex alpha/search endpoint and auth", async () => withAgentDir(async () => {
	const turnId = "0198e2c6-7a5b-7c10-9d1e-2f3a4b5c6d7e";
	const model = {
		provider: "openai-codex",
		api: "openai-codex-responses",
		id: "gpt-5.6-sol",
		baseUrl: "https://chatgpt.example/backend-api",
		headers: {},
		input: ["text", "image"],
	} as any;
	let requestUrl = "";
	let requestBody: any;
	let requestHeaders: Headers | undefined;
	globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
		requestUrl = String(url);
		requestBody = JSON.parse(String(init?.body));
		requestHeaders = new Headers(init?.headers as HeadersInit);
		return Response.json({
			output: "citeturn0search0 Search result",
			results: [{ ref_id: "turn0search0", url: "https://example.com" }],
		});
	}) as typeof fetch;

	const result = await standaloneWebSearch({
		search_query: [{ q: "latest docs", recency: 7, domains: ["example.com"] }],
		response_length: "short",
	}, {
		cwd: process.cwd(),
		model,
		modelRegistry: {
			async getApiKeyAndHeaders() {
				return { ok: true as const, apiKey: jwt(), headers: {} };
			},
		},
		sessionManager: { getSessionId: () => "session-1" },
	}, undefined, { turnId });

	assert.equal(requestUrl, "https://chatgpt.example/backend-api/codex/alpha/search");
	assert.equal(requestHeaders?.get("chatgpt-account-id"), "acct_test");
	assert.equal(requestHeaders?.get("authorization"), `Bearer ${jwt()}`);
	assert.match(
		requestBody.id,
		/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
	);
	assert.equal(requestBody.model, "gpt-5.6-sol");
	assert.deepEqual(
		JSON.parse(requestHeaders?.get("x-codex-turn-metadata") ?? ""),
		{
			session_id: requestBody.id,
			thread_id: requestBody.id,
			turn_id: turnId,
			model: "gpt-5.6-sol",
		},
	);
	assert.equal("input" in requestBody, false);
	assert.deepEqual(requestBody.commands.search_query, [{
		q: "latest docs",
		recency: 7,
		domains: ["example.com"],
	}]);
	assert.equal(requestBody.max_output_tokens, 10_000);
	assert.equal((result.content[0] as any).text, "citeturn0search0 Search result");
}));

test("standalone web search surfaces a backend no-tool-response sentinel as an error", async () => withAgentDir(async () => {
	const model = {
		provider: "openai-codex",
		api: "openai-codex-responses",
		id: "gpt-5.6-sol",
		baseUrl: "https://chatgpt.example/backend-api",
		headers: {},
		input: ["text", "image"],
	} as any;
	globalThis.fetch = (async () => Response.json({
		output: "Found no tool response. This likely means the arguments you provided were not valid.",
		results: [],
	})) as typeof fetch;

	await assert.rejects(
		standaloneWebSearch({ weather: [{ location: "Beijing, China" }] }, {
			cwd: process.cwd(),
			model,
			modelRegistry: {
				async getApiKeyAndHeaders() {
					return { ok: true as const, apiKey: jwt(), headers: {} };
				},
			},
		}),
		/backend returned no tool response for weather[\s\S]*retry with search_query/i,
	);
}));

test("standalone web search supports API-key endpoints for user-added profiles", async () => withAgentDir(async (agentDir) => {
	writeModels(agentDir, [{
		id: "custom/search-model",
		extends: "openai/gpt-5.6-sol",
		responses: { endpoint: "openai" },
	}]);
	const model = {
		provider: "custom",
		api: "openai-responses",
		id: "search-model",
		baseUrl: "https://api.example/v1",
		headers: {},
		input: ["text"],
	} as any;
	let requestUrl = "";
	let accountHeader: string | null = "unset";
	globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
		requestUrl = String(url);
		accountHeader = new Headers(init?.headers as HeadersInit).get("chatgpt-account-id");
		return Response.json({ output: "search result", results: [] });
	}) as typeof fetch;

	await standaloneWebSearch({ search_query: [{ q: "query" }] }, {
		cwd: process.cwd(),
		model,
		modelRegistry: {
			async getApiKeyAndHeaders() {
				return { ok: true as const, apiKey: "plain-key", headers: {} };
			},
		},
	});

	assert.equal(requestUrl, "https://api.example/v1/alpha/search");
	assert.equal(accountHeader, null);
}));

test("standalone image generation uses the active provider Images endpoint and saves PNG", async () => withAgentDir(async (agentDir) => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-codex-standalone-image-output-"));
	const model = {
		provider: "openai-codex",
		api: "openai-codex-responses",
		id: "gpt-5.6-sol",
		baseUrl: "https://chatgpt.example/backend-api",
		headers: {},
		input: ["text", "image"],
	} as any;
	const base64 = Buffer.from("png-bytes").toString("base64");
	let requestUrl = "";
	let requestBody: any;
	let requestHeaders: Headers | undefined;
	globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
		requestUrl = String(url);
		requestBody = JSON.parse(String(init?.body));
		requestHeaders = new Headers(init?.headers as HeadersInit);
		return Response.json({ created: 1, data: [{ b64_json: base64 }] });
	}) as typeof fetch;
	try {
		const settings = loadModelSettings(model, cwd);
		const result = await standaloneImageGeneration({
			prompt: "A tiny diagram",
			output_format: "webp",
		}, {
			cwd,
			model,
			modelRegistry: {
				async getApiKeyAndHeaders() {
					return { ok: true as const, apiKey: jwt(), headers: {} };
				},
			},
		}, settings, undefined, {
			callId: "call-image",
			turnId: "turn-image",
		});

		assert.equal(requestUrl, "https://chatgpt.example/backend-api/codex/images/generations");
		assert.equal(requestHeaders?.get("x-codex-image-turn-id"), "turn-image");
		assert.deepEqual(requestBody, {
			model: "gpt-image-2",
			prompt: "A tiny diagram",
			background: "auto",
			quality: "auto",
			size: "auto",
		});
		const image = result.content.find((part: any) => part.type === "image") as any;
		assert.equal(image.mimeType, "image/png");
		assert.equal(image.data, base64);
		assert.match((result.details as any).saved.path, /\.png$/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	}
}));

test("standalone web search sends the recent visible conversation tail", async () => withAgentDir(async () => {
	const turnId = "0198e2c6-7a5b-7c11-9d1e-2f3a4b5c6d7e";
	const model = {
		provider: "openai-codex",
		api: "openai-codex-responses",
		id: "gpt-5.6-sol",
		baseUrl: "https://chatgpt.example/backend-api",
		headers: {},
		input: ["text", "image"],
	} as any;
	let requestBody: any;
	globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
		requestBody = JSON.parse(String(init?.body));
		return Response.json({ output: "search result", results: [] });
	}) as typeof fetch;
	const timestamp = new Date().toISOString();
	const assistantMessage = (text: string) => ({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-5.6-sol",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
	const branch = [
		{
			type: "message",
			id: "old-user",
			parentId: null,
			timestamp,
			message: { role: "user", content: "old user", timestamp: Date.now() },
		},
		{
			type: "message",
			id: "old-assistant",
			parentId: "old-user",
			timestamp,
			message: assistantMessage("old assistant"),
		},
		{
			type: "message",
			id: "previous-user",
			parentId: "old-assistant",
			timestamp,
			message: { role: "user", content: "previous user", timestamp: Date.now() },
		},
		{
			type: "message",
			id: "previous-assistant",
			parentId: "previous-user",
			timestamp,
			message: assistantMessage("previous assistant"),
		},
		{
			type: "message",
			id: "current-user",
			parentId: "previous-assistant",
			timestamp,
			message: { role: "user", content: "current user", timestamp: Date.now() },
		},
	] as any[];

	await standaloneWebSearch({ search_query: [{ q: "query" }] }, {
		cwd: process.cwd(),
		model,
		modelRegistry: {
			async getApiKeyAndHeaders() {
				return { ok: true as const, apiKey: jwt(), headers: {} };
			},
		},
		sessionManager: {
			getSessionId: () => "session-1",
			getBranch: () => branch,
		},
	}, undefined, { turnId });

	assert.deepEqual(requestBody.input, [
		{
			type: "message",
			role: "user",
			content: [{ type: "input_text", text: "previous user" }],
		},
		{
			type: "message",
			role: "assistant",
			content: [{ type: "output_text", text: "previous assistant" }],
		},
		{
			type: "message",
			role: "user",
			content: [{ type: "input_text", text: "current user" }],
			internal_chat_message_metadata_passthrough: {
				turn_id: turnId,
			},
		},
	]);
}));

test("standalone image editing can use recent conversation images", async () => withAgentDir(async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-codex-recent-image-output-"));
	const model = {
		provider: "openai-codex",
		api: "openai-codex-responses",
		id: "gpt-5.6-sol",
		baseUrl: "https://chatgpt.example/backend-api",
		headers: {},
		input: ["text", "image"],
	} as any;
	const generated = Buffer.from("generated").toString("base64");
	let requestBody: any;
	let requestHeaders: Headers | undefined;
	globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
		requestBody = JSON.parse(String(init?.body));
		requestHeaders = new Headers(init?.headers as HeadersInit);
		return Response.json({ created: 1, data: [{ b64_json: generated }] });
	}) as typeof fetch;
	const timestamp = new Date().toISOString();
	const imageOne = Buffer.from("one").toString("base64");
	const imageTwo = Buffer.from("two").toString("base64");
	const branch = [
		{
			type: "message",
			id: "user-image",
			parentId: null,
			timestamp,
			message: {
				role: "user",
				content: [{ type: "image", data: imageOne, mimeType: "image/png" }],
				timestamp: Date.now(),
			},
		},
		{
			type: "message",
			id: "tool-image",
			parentId: "user-image",
			timestamp,
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "view_image",
				content: [{ type: "image", data: imageTwo, mimeType: "image/webp" }],
				isError: false,
				timestamp: Date.now(),
			},
		},
	] as any[];
	try {
		await standaloneImageGeneration({
			prompt: "Edit the latest images",
			num_last_images_to_include: 2,
		}, {
			cwd,
			model,
			modelRegistry: {
				async getApiKeyAndHeaders() {
					return { ok: true as const, apiKey: jwt(), headers: {} };
				},
			},
			sessionManager: { getBranch: () => branch },
		}, loadModelSettings(model, cwd), undefined, {
			callId: "call-image",
			turnId: "turn-image",
		});

		assert.deepEqual(requestBody.images, [
			{ image_url: `data:image/png;base64,${imageOne}` },
			{ image_url: `data:image/webp;base64,${imageTwo}` },
		]);
		assert.equal(requestHeaders?.get("x-codex-image-turn-id"), "turn-image");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}));
