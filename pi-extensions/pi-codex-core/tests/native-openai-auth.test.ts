import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { InMemoryCredentialStore, type Credential } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createEventBus, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { registerResponsesProviderRuntime } from "../src/extension/provider-runtime.js";
import { createProviderHarness } from "./support/openai-codex-test-support.js";
import { buildRequestBody } from "../src/providers/openai-codex/request-body.js";
import { resolveCodexRequestProfile } from "@oai404iao/pi-codex-runtime/internal/codex-request-profile";

const originalEnv = { dir: process.env.PI_CODING_AGENT_DIR, key: process.env.OPENAI_API_KEY };
const originalFetch = globalThis.fetch;
let cwd: string;
beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "pi-native-openai-auth-"));
	process.env.PI_CODING_AGENT_DIR = cwd;
	process.env.OPENAI_API_KEY = "sk-environment";
	const configDir = join(cwd, "extensions", "pi-codex-minimal-tools");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(configDir, "config.json"), JSON.stringify({ webSocketEnabled: false }));
	globalThis.fetch = async () => { throw new Error("Unexpected network request"); };
});
afterEach(() => {
	globalThis.fetch = originalFetch;
	for (const [key, value] of [["PI_CODING_AGENT_DIR", originalEnv.dir], ["OPENAI_API_KEY", originalEnv.key]]) {
		if (value === undefined) delete process.env[key!];
		else process.env[key!] = value;
	}
});

const oauth = (expires = Date.now() + 3_600_000): Credential => ({
	type: "oauth", access: "chatgpt-access-token", refresh: "fixture-refresh-token", expires,
});
const context = { messages: [{ role: "user" as const, content: "hello", timestamp: 1 }], tools: [] };
const completion = () => new Response(`data: ${JSON.stringify({
	type: "response.completed",
	response: { id: "fixture", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } },
})}\n\n`, { headers: { "content-type": "text/event-stream" } });

async function runtimeWith(credential?: Credential, provider?: ReturnType<typeof openaiProvider>) {
	const credentials = new InMemoryCredentialStore();
	if (credential) await credentials.modify("openai", async () => credential);
	const runtime = await ModelRuntime.create({
		credentials, modelsPath: null, modelsStorePath: join(cwd, "models-store.json"),
		allowModelNetwork: false, refreshOnCreate: false,
	});
	registerResponsesProviderRuntime({
		events: createEventBus(),
		on() {},
		registerProvider(name: string, config: any) { runtime.registerProvider(name, config); },
	} as any, { getCurrentCwd: () => cwd });
	if (provider) runtime.registerNativeProvider({ ...runtime.getProvider("openai")!, auth: provider.auth });
	return { runtime, credentials };
}

async function request(runtime: ModelRuntime) {
	const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
	const message = await runtime.streamSimple(runtime.getModel("openai", "gpt-5.5")!, context, {
		temperature: 0.5, maxTokens: 32, transport: "sse", maxRetries: 0,
		fetch: async (input, init) => {
			requests.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
			return completion();
		},
	}).result();
	return { message, requests };
}

test("native OpenAI auth selects stored OAuth or key before env, with the same Responses URL", async () => {
	for (const [credential, expected, chatgpt] of [
		[oauth(), "chatgpt-access-token", true],
		[{ type: "api_key", key: "sk-stored" }, "sk-stored", false],
		[undefined, "sk-environment", false],
	] as const) {
		const { runtime } = await runtimeWith(credential);
		const { message, requests } = await request(runtime);
		assert.equal(message.stopReason, "stop", message.errorMessage ?? "");
		assert.equal(requests.length, 1);
		const actual = requests[0]!;
		assert.equal(actual.url, "https://api.openai.com/v1/responses");
		assert.equal(actual.headers.get("authorization"), `Bearer ${expected}`);
		assert.equal(actual.headers.get("chatgpt-account-id"), null);
		assert.equal(actual.body.temperature, chatgpt ? undefined : 0.5);
		assert.equal(actual.body.max_output_tokens, chatgpt ? undefined : 32);
		assert.equal(actual.body.prompt_cache_retention, undefined);
		assert.equal(actual.body.prompt_cache_options, undefined);
	}
});

test("Pi runtime API key overrides stored OAuth without plugin credential selection", async () => {
	const { runtime, credentials } = await runtimeWith(oauth());
	await runtime.setRuntimeApiKey("openai", "sk-runtime");
	const { message, requests } = await request(runtime);
	assert.equal(message.stopReason, "stop", message.errorMessage ?? "");
	assert.equal(requests[0]!.headers.get("authorization"), "Bearer sk-runtime");
	assert.equal(requests[0]!.body.temperature, 0.5);
	assert.equal((await credentials.read("openai"))?.type, "oauth");
});

test("Pi resolves refreshed OAuth once and forwards its headers and base URL into the shim", async () => {
	let refreshes = 0;
	const provider = openaiProvider();
	provider.auth.oauth = {
		...provider.auth.oauth!,
		refresh: async () => {
			refreshes++;
			return { type: "oauth", refresh: "rotated", access: "refreshed", expires: Date.now() + 3_600_000 };
		},
		toAuth: async credential => ({
			apiKey: credential.access, baseUrl: "https://resolved.invalid/v1",
			headers: { authorization: null, "x-api-key": "resolved-header" },
		}),
	};
	const { runtime, credentials } = await runtimeWith(oauth(0), provider);
	const { message, requests } = await request(runtime);
	assert.equal(message.stopReason, "stop", message.errorMessage ?? "");
	assert.equal(refreshes, 1);
	assert.equal(requests[0]!.url, "https://resolved.invalid/v1/responses");
	assert.equal(requests[0]!.headers.get("authorization"), null);
	assert.equal(requests[0]!.headers.get("x-api-key"), "resolved-header");
	assert.equal(requests[0]!.body.temperature, 0.5);
	const refreshed = await credentials.read("openai");
	assert(refreshed?.type === "oauth");
	assert.equal(refreshed.access, "refreshed");
});

test("failed Pi OAuth refresh never falls back to the environment API key", async () => {
	const provider = openaiProvider();
	provider.auth.oauth = { ...provider.auth.oauth!, refresh: async () => { throw new Error("fixture refresh failed"); } };
	const { runtime } = await runtimeWith(oauth(0), provider);
	const { message, requests } = await request(runtime);
	assert.equal(message.stopReason, "error");
	assert.match(message.errorMessage ?? "", /fixture refresh failed/);
	assert.equal(requests.length, 0);
});

test("shim does not independently read OPENAI_API_KEY when Pi supplies header-only or no auth", async () => {
	const { providers } = createProviderHarness({ cwd });
	const model = {
		provider: "openai", api: "openai-responses", id: "gpt-5.5", baseUrl: "https://proxy.invalid/v1",
		input: ["text"], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	let calls = 0;
	const fetch = async (_input: unknown, init?: RequestInit) => {
		calls++;
		assert.equal(new Headers(init?.headers).get("authorization"), null);
		assert.equal(new Headers(init?.headers).get("cf-aig-authorization"), "Bearer gateway");
		return completion();
	};
	const headers = { "cf-aig-authorization": "Bearer gateway" };
	const ok = await providers.openai.streamSimple(model, context, { headers, fetch }).result();
	assert.equal(ok.stopReason, "stop", ok.errorMessage);
	const denied = await providers.openai.streamSimple(model, context, { fetch }).result();
	assert.equal(denied.stopReason, "error");
	assert.match(denied.errorMessage, /No request authentication/);
	assert.equal(calls, 1);
});

test("OpenAI request limits keep native URL/token boundaries and model compatibility", () => {
	const base = {
		provider: "openai", api: "openai-responses", id: "gpt-5.5", baseUrl: "https://api.openai.com/v1",
		input: ["text"], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const profile = resolveCodexRequestProfile({ responsesMode: "standard" });
	const options = { temperature: 0.3, maxTokens: 1 };
	for (const [overrides, auth, temperature, cap] of [
		[{}, { apiKey: "chatgpt-access" }, undefined, undefined],
		[{}, { apiKey: "sk-key" }, 0.3, 16],
		[{ baseUrl: "https://proxy.invalid" }, { apiKey: "chatgpt-access" }, 0.3, 16],
		[{}, { headers: { authorization: "Bearer header-only" } }, 0.3, 16],
		[{ compat: { supportsMaxOutputTokens: false } }, { apiKey: "sk-key" }, 0.3, undefined],
		[{ provider: "openai-codex", api: "openai-codex-responses" }, { apiKey: "legacy-token" }, 0.3, undefined],
	] as const) {
		const body = buildRequestBody({ ...base, ...overrides } as any, context, profile, { ...options, ...auth });
		assert.equal(body.temperature, temperature);
		assert.equal(body.max_output_tokens, cap);
	}
});
