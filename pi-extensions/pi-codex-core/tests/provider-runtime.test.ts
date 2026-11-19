import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { getCurrentSystemPrompt, type Context, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { resetCodexWireState } from "@oai404iao/pi-codex-runtime/internal/codex-wire-identity";
import { registerResponsesProviderRuntime } from "@oai404iao/pi-codex-core/internal/extension/provider-runtime";
import { closeProviderWebSocketSessions } from "@oai404iao/pi-codex-core/internal/providers/openai-codex/websocket-session";
import { codexJwt, createProviderHarness } from "./support/openai-codex-test-support.js";
import { createAssistantMessage, deferred, eventContext, responsesModel, withCodexSettings } from "../../../tests/codex/support/provider-lifecycle-test-support.js";
import { startWebSocketServer } from "./support/websocket-test-support.js";

const originalFetch = globalThis.fetch;
const image = { type: "image_generation_call", id: "ig_one", status: "completed", result: "cG5n", output_format: "png" };
const events = [
	{ type: "response.created", response: { id: "resp_image" } },
	{ type: "response.output_item.done", output_index: 0, item: image },
	{ type: "response.completed", response: { id: "resp_image", status: "completed", output: [image] } },
];
const sseResponse = () => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
	headers: { "content-type": "text/event-stream" },
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	closeProviderWebSocketSessions();
	resetCodexWireState();
});

for (const api of ["openai-responses", "openai-codex-responses"] as const) {
	test(`${api} native fallback preserves resolved request options and the projected checkpoint`, async () => {
		await withCodexSettings({}, async cwd => {
			const codex = api === "openai-codex-responses";
			const model = {
				...responsesModel, id: "unconfigured-fixture", provider: codex ? "openai-codex" : "openai", api,
				compat: { supportsMidConvoSystemMessages: true },
			};
			const { providers } = createProviderHarness({ cwd });
			const checkpoint = { type: "compaction", encrypted_content: "fixture-checkpoint" };
			const context: Context = { messages: [
				{ role: "system", content: "base instructions", sections: { rules: "previous rules" }, timestamp: 1 },
				{ ...createAssistantMessage(model), stopReason: "stop", content: [
					{ type: "thinking", thinking: "", thinkingSignature: JSON.stringify(checkpoint) },
				] },
				{ role: "system", content: "", sections: { rules: "current rules" }, timestamp: 2 },
				{ role: "user", content: "next turn", timestamp: 3 },
			] };
			const prompt = getCurrentSystemPrompt(context.messages);
			const apiKey = codex ? codexJwt() : "sk-resolved";
			const requests: Array<{ url: string; headers: Headers }> = [];
			let payload: any;
			const options: SimpleStreamOptions = {
				apiKey, transport: "sse", maxRetries: 0, sessionId: "native-fallback",
				identity: { userAgent: { custom: "fixture-client" } }, headers: { "x-fixture": "resolved" },
				env: { OPENAI_API_KEY: "sk-env-not-resolved", PI_CACHE_RETENTION: "long" },
				onPayload(body) { payload = body; },
				fetch: async (input, init) => {
					const request = new Request(input, init);
					requests.push({ url: request.url, headers: request.headers });
					return new Response('data: {"type":"response.completed","response":{"id":"fixture","status":"completed","output":[]}}\n\n', {
						headers: { "content-type": "text/event-stream" },
					});
				},
			};
			const stream = providers[model.provider].streamSimple(model, context, options);
			const result = await stream.result();
			assert.equal(result.stopReason, "stop", result.errorMessage);
			assert.equal(result.api, api);
			assert.equal(requests.length, 1);
			const [{ url, headers }] = requests;
			assert.equal(url, `${model.baseUrl}${codex ? "/codex" : ""}/responses`);
			assert.equal(headers.get("authorization"), `Bearer ${apiKey}`);
			assert.equal(headers.get("user-agent"), "fixture-client");
			assert.equal(headers.get("x-fixture"), "resolved");
			assert.equal(headers.get("chatgpt-account-id"), codex ? "acct_test" : null);
			assert.deepEqual(codex ? payload.instructions : payload.input[0], codex ? prompt : { role: "system", content: prompt });
			assert.deepEqual(payload.input[codex ? 0 : 1], checkpoint);
			assert.deepEqual(payload.input.at(-1), { role: "user", content: [{ type: "input_text", text: "next turn" }] });
			assert.equal(payload.input.length, codex ? 2 : 3);
			assert.equal(payload.prompt_cache_retention, codex ? undefined : "24h");

			const missingAuth = await providers[model.provider].streamSimple(model, context, { ...options, apiKey: undefined }).result();
			assert.equal(missingAuth.stopReason, "error");
			assert.match(missingAuth.errorMessage, /No API key/);
			assert.equal(requests.length, 1, "unresolved environment credentials must never reach native fallback requests");
		});
	});
}

for (const transport of ["sse", "websocket"] as const) {
	test(`${transport} runtime works without presentation, preserving images without file writes or renderers`, async () => {
		await withCodexSettings({ openaiTransport: transport, openaiWebSocketPrewarm: false }, async cwd => {
			const server = transport === "websocket" ? await startWebSocketServer([() => events]) : undefined;
			try {
				if (transport === "sse") globalThis.fetch = async () => sseResponse();
				const harness = createProviderHarness({ register: registerResponsesProviderRuntime, cwd });
				const model = { ...responsesModel, baseUrl: server?.url ?? responsesModel.baseUrl };
				const output = await harness.providers.openai.streamSimple(model, {
					messages: [{ role: "user", content: "fixture", timestamp: 0 }], tools: [],
				}, { apiKey: "test-key", transport, sessionId: "lifecycle-test" }).result();
				assert.equal(output.stopReason, "stop");
				assert.equal(output.responseId, "resp_image");
				assert.equal(output.content[0].type, "image_generation_call");
				assert.equal(output.content[0].item.result, image.result);
				assert.equal(existsSync(join(cwd, ".pi/openai-codex-images")), false);
				assert.deepEqual(Object.keys(harness.renderers), []);
				assert.equal(harness.messages.length, 0);
				for (const handler of harness.handlers.session_shutdown ?? []) {
					await handler({}, eventContext(model));
				}
			} finally {
				closeProviderWebSocketSessions();
				await server?.close();
			}
		});
	});
}

test("global WebSocket gate forces SSE over a session transport override", async () => {
	await withCodexSettings({ webSocketEnabled: false }, async cwd => {
		const server = await startWebSocketServer([() => events]);
		let requestCount = 0;
		try {
			globalThis.fetch = async () => {
				requestCount++;
				return sseResponse();
			};
			const harness = createProviderHarness({
				register: registerResponsesProviderRuntime,
				cwd,
			});
			const output = await harness.providers.openai.streamSimple(
				{ ...responsesModel, baseUrl: server.url },
				{
					messages: [{ role: "user", content: "fixture", timestamp: 0 }],
					tools: [],
				},
				{
					apiKey: "test-key",
					transport: "websocket",
					sessionId: "lifecycle-test",
				},
			).result();
			assert.equal(output.stopReason, "stop");
			assert.equal(requestCount, 1);
		} finally {
			closeProviderWebSocketSessions();
			await server.close();
		}
	});
});

test("legacy registration captures display ownership before network I/O, not when the response arrives", async () => {
	await withCodexSettings({ openaiTransport: "sse", openaiWebSocketPrewarm: false }, async cwd => {
		const response = deferred<Response>();
		const entered = deferred<void>();
		globalThis.fetch = async () => { entered.resolve(); return response.promise; };
		const harness = createProviderHarness({ cwd });
		const pending = harness.providers.openai.streamSimple(responsesModel, {
			messages: [{ role: "user", content: "fixture", timestamp: 0 }], tools: [],
		}, { apiKey: "test-key", transport: "sse", sessionId: "lifecycle-test" }).result();
		await entered.promise;
		try {
			for (const handler of harness.handlers.session_shutdown ?? []) await handler({}, eventContext());
			for (const handler of harness.handlers.session_start ?? []) await handler({}, eventContext(responsesModel, "replacement"));
		} finally {
			response.resolve(sseResponse());
		}
		const output = await pending;
		assert.equal(output.stopReason, "stop");
		for (const handler of harness.handlers.agent_end ?? []) await handler({});
		await new Promise(resolve => setTimeout(resolve, 10));
		assert.equal(harness.messages.length, 0);
		for (const handler of harness.handlers.session_shutdown ?? []) await handler({}, eventContext(responsesModel, "replacement"));
	});
});
