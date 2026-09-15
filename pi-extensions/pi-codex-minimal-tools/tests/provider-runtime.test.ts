import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { resetCodexWireState } from "../src/codex-wire-identity.js";
import { registerResponsesProviderRuntime } from "../src/extension/provider-runtime.js";
import { closeProviderWebSocketSessions } from "../src/providers/openai-codex/websocket-session.js";
import { createProviderHarness } from "./support/openai-codex-test-support.js";
import { deferred, eventContext, responsesModel, withCodexSettings } from "./support/provider-lifecycle-test-support.js";
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
