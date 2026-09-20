import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import codexCore from "../../pi-codex-core/src/index.ts";
import { piSession, scratch } from "./helpers.ts";
import { grammarResponse, wireTools, type FixtureCall } from "./grammar-fixtures.ts";

const host = process.env.CODE_MODE_TEST_HOST;
assert(host, "CODE_MODE_TEST_HOST required; no silent grammar integration skip");
process.env.XDG_STATE_HOME = await scratch("grammar-state");
const raw = '// @exec: {"yield_time_ms":0,"timeout_ms":10000,"max_tokens":8192}\ntext(load("prior")); text("grammar-result");';

for (const kind of ["native-responses", "native-completions", "codex-standard", "codex-lite"]) {
	test(`S3 ${kind}: JSON → grammar → JSON → Anthropic history, real Pi and Host`, { timeout: 25000 }, async (t) => {
		const api = kind === "native-completions" ? "openai-completions" : "openai-responses";
		const previousDir = process.env.PI_CODING_AGENT_DIR;
		const configRoot = await scratch(`grammar-${kind}`);
		process.env.PI_CODING_AGENT_DIR = configRoot;
		t.after(() => {
			if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir;
		});
		const config = join(configRoot, "extensions/pi-codex-minimal-tools");
		await mkdir(config, { recursive: true });
		await writeFile(join(config, "config.json"), JSON.stringify({ webSocketEnabled: false }));
		await writeFile(join(config, "models.json"), JSON.stringify({ version: 1, models: [{
			id: "s1-fixture/s1", extends: kind === "codex-lite" ? "openai/gpt-5.6-sol" : "openai/gpt-5.5",
			responses: { endpoint: "openai", transport: "sse", websocketPrewarm: false },
			tools: { applyPatch: false, webSearch: false, imageGeneration: false, viewImage: false }, compaction: "pi",
		}] }));
		const requests: Record<string, unknown>[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input, init) => {
			const request = new Request(input, init);
			assert.equal(new URL(request.url).origin, "https://s1-fixture.invalid", "no live account/network");
			const body = await request.json() as Record<string, unknown>;
			requests.push(body);
			const n = requests.length;
			assert(n <= 8, "unexpected model request/retry");
			let call: FixtureCall | undefined;
			if (n === 1) call = { name: "exec", args: { code: 'store("prior",42); text("json-first")', yield_time_ms: 0, timeout_ms: 10000 } };
			if (n === 4) call = { name: "exec", input: raw };
			if (n === 2 || n === 5) {
				const cellId = [...JSON.stringify(body.messages ?? body.input).matchAll(/cm-[a-f0-9-]{36}/g)].at(-1)?.[0];
				assert(cellId);
				call = { name: "wait", args: { cell_id: cellId, yield_time_ms: 10000 } };
			}
			return grammarResponse(n === 8 ? "anthropic-messages" : api, call, `call_${n}`);
		};
		t.after(() => { globalThis.fetch = originalFetch; });
		const f = await piSession(t, { host, grant: true, api, grammar: true, protocol: "json",
			factories: kind.startsWith("codex") ? [codexCore] : undefined });
		await f.session.prompt("Use JSON Code Mode.");
		assert.equal(requests.length, 3, JSON.stringify(f.session.messages));
		await f.session.prompt("/code-mode protocol auto");
		assert.match(f.session.getAllTools().find((tool) => tool.name === "exec")!.description, /raw JavaScript grammar/);
		await f.session.prompt("Use raw Code Mode; retain the store.");
		assert.equal(requests.length, 6, JSON.stringify(f.session.messages));
		const waits = f.session.messages.filter((message) => message.role === "toolResult" && message.toolName === "wait");
		assert.match(JSON.stringify(waits.at(-1)), /42\\ngrammar-result/);
		const definition = wireTools(requests[3]).find((tool) => tool.name === "exec" || (tool.custom as { name?: string })?.name === "exec");
		assert.equal(definition?.type, "custom", kind);
		assert.match(JSON.stringify(requests[3].input ?? requests[3].messages), /@exec:/);
		assert.match(JSON.stringify(requests[3].input ?? requests[3].messages), /timeout_ms/);
		const savedFirst = f.session.messages.find((message) => message.role === "assistant" && message.content.some((block) => block.type === "toolCall" && block.name === "exec"));
		assert(savedFirst?.role === "assistant");
		const firstCall = savedFirst.content.find((block) => block.type === "toolCall");
		assert(firstCall?.type === "toolCall");
		assert.equal(firstCall.arguments.yield_time_ms, 0, "projection must not rewrite saved args");
		assert.equal(firstCall.arguments.code, 'store("prior",42); text("json-first")');
		await f.session.prompt("/code-mode protocol json");
		await f.session.prompt("Review prior results without another execution.");
		assert.equal(requests.length, 7);
		const json = wireTools(requests[6]).find((tool) => tool.name === "exec" || (tool.function as { name?: string })?.name === "exec");
		assert.equal(json?.type, "function");
		if (api === "openai-responses") {
			const replay = requests[6].input as Record<string, unknown>[];
			assert(!replay.some((item) => item.type === "custom_tool_call" || item.type === "custom_tool_call_output"));
			assert(replay.some((item) => item.type === "function_call_output"));
			const priorRaw = replay.find((item) => item.type === "function_call" && item.call_id === "call_4");
			assert.equal(JSON.parse(String(priorRaw?.arguments)).code, raw);
		}
		f.modelRuntime.registerProvider("anthro-fixture", {
			api: "anthropic-messages", apiKey: "fixture-not-real", baseUrl: "https://s1-fixture.invalid",
			models: [{ id: "second", name: "Anthropic fixture", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 2000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		});
		await f.session.setModel(f.modelRuntime.getModel("anthro-fixture", "second")!);
		await f.session.prompt("/code-mode protocol auto");
		await f.session.prompt("Continue without replaying code.");
		assert.equal(requests.length, 8);
		assert.match(JSON.stringify(requests[7].messages), /grammar-result/);
		assert.match(JSON.stringify(requests[7].messages), /@exec:/);
		assert(wireTools(requests[7]).some((tool) => tool.name === "exec" && tool.input_schema));
		assert.deepEqual(f.errors, []);
	});
}
