import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { standaloneWebSearch } from "@oai404iao/pi-codex-web-search/internal/tools/web-search";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { beginCodexTurn, endCodexTurn } from "@oai404iao/pi-codex-runtime/internal/codex-wire-identity";

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

test("standalone search snapshots turn/history before delayed auth and cancels before HTTP", async () => withAgentDir(async () => {
	const model = { provider: "openai", api: "openai-responses", id: "gpt-5.6-sol", baseUrl: "https://fixture.invalid/v1", input: ["text"] } as any;
	const sm = SessionManager.inMemory(process.cwd());
	sm.appendMessage({ role: "user", content: "turn A", timestamp: 1 });
	const firstTurn = beginCodexTurn(sm.getSessionId());
	let release!: () => void;
	let body: any, metadata: any, requests = 0;
	globalThis.fetch = async (_url, init) => {
		requests++;
		body = JSON.parse(String(init?.body));
		metadata = JSON.parse(new Headers(init?.headers).get("x-codex-turn-metadata")!);
		return Response.json({ output: "snapshot", results: [] });
	};
	const context = {
		cwd: process.cwd(), model, sessionManager: sm,
		modelRegistry: { async getApiKeyAndHeaders() {
			await new Promise<void>((resolve) => { release = resolve; });
			return { ok: true as const, apiKey: "fixture" };
		} },
	};
	try {
		const pending = standaloneWebSearch({ search_query: [{ q: "fixture" }] }, context);
		await Promise.resolve();
		endCodexTurn(sm.getSessionId());
		beginCodexTurn(sm.getSessionId());
		sm.appendMessage({ role: "user", content: "turn B must not leak into A", timestamp: 2 });
		release();
		await pending;
		assert.equal(metadata.turn_id, firstTurn.turnId);
		assert.match(JSON.stringify(body.input), /turn A/);
		assert.doesNotMatch(JSON.stringify(body.input), /turn B/);
		const controller = new AbortController();
		const cancelled = standaloneWebSearch({ search_query: [{ q: "fixture" }] }, context, controller.signal);
		await Promise.resolve();
		controller.abort();
		release();
		await assert.rejects(cancelled);
		assert.equal(requests, 1, "cancelled auth must not start a network request");
	} finally { endCodexTurn(sm.getSessionId()); }
}));

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
