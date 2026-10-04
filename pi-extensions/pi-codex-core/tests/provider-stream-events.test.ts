import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import type { Model } from "@earendil-works/pi-ai/compat";
import { mapCodexEvents } from "../src/providers/openai-codex/events.js";
import { WebSocketHandshakeError } from "../src/providers/openai-codex/errors.js";
import { closeProviderWebSocketSessions } from "../src/providers/openai-codex/websocket-session.js";
import { resetCodexWireState } from "@oai404iao/pi-codex-runtime/internal/codex-wire-identity";
import type { StreamEventShape } from "@oai404iao/pi-codex-runtime/internal/providers/openai-codex/types";
import { createProviderHarness, codexJwt } from "./support/openai-codex-test-support.js";
import { startWebSocketServer, successEvents } from "./support/websocket-test-support.js";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
beforeEach(() => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-provider-events-"));
	const configDir = join(agentDir, "extensions", "pi-codex-minimal-tools");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(configDir, "config.json"), "{}");
	process.env.PI_CODING_AGENT_DIR = agentDir;
});
afterEach(() => {
	closeProviderWebSocketSessions();
	resetCodexWireState();
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

async function* source(events: StreamEventShape[]) {
	yield* events;
}

for (const transport of ["sse", "auto"] as const) {
	test(`${transport} observer failures neither retry nor negotiate another transport`, async () => {
		for (const cause of [
			new Error("fetch failed"),
			new Error("websocket_connection_limit_reached"),
			new Error("previous_response_not_found"),
			new WebSocketHandshakeError(426, "upgrade required"),
		]) {
			const events = [{ type: "error", error: { message: "provider failure" } }];
			const server = transport === "auto" ? await startWebSocketServer([() => events]) : undefined;
			let httpRequests = 0;
			let callbacks = 0;
			try {
				const model = {
					provider: "openai", api: "openai-responses", id: "gpt-5.5",
					baseUrl: server?.url ?? "https://example.invalid/v1",
					headers: {}, input: ["text"], reasoning: false,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				};
				const message = await createProviderHarness().providers.openai.streamSimple(model, {
					messages: [{ role: "user", content: "fixture", timestamp: 1 }], tools: [],
				}, {
					apiKey: "sk-fixture", transport, maxRetries: 1, maxRetryDelayMs: 1,
					env: { NO_PROXY: "*" },
					fetch: async () => {
						httpRequests++;
						return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
					},
					onProviderStreamEvent: async () => { callbacks++; throw cause; },
				}).result();
				assert.equal(message.stopReason, "error");
				assert.equal(message.errorMessage, `Provider stream event callback failed: ${cause.message}`);
				assert.equal(callbacks, 1);
				assert.equal(httpRequests, transport === "sse" ? 1 : 0);
				if (server) assert.equal(server.requests.length, 1);
			} finally {
				await server?.close();
			}
		}
	});
}

test("raw observation is awaited before normalization and excludes synthesized items", async () => {
	const terminal = {
		type: "response.done",
		response: { status: "completed", output: [{ type: "compaction", id: "compact", encrypted_content: "opaque" }] },
	} as StreamEventShape;
	const observed: StreamEventShape[] = [];
	const normalized: StreamEventShape[] = [];
	for await (const event of mapCodexEvents(source([terminal]), undefined, async event => {
		await new Promise<void>(resolve => setImmediate(resolve));
		observed.push(event);
	})) {
		assert.deepEqual(observed, [terminal]);
		normalized.push(event);
	}
	assert.deepEqual(normalized.map(event => event.type), ["response.output_item.done", "response.completed"]);
	assert.equal(observed[0]?.type, "response.done");
});

for (const type of ["error", "response.failed"]) {
	test(`raw observer receives ${type} before error conversion`, async () => {
		const event = type === "error"
			? { type, error: { code: "invalid_request", message: "fixture failure" } }
			: { type, response: { error: { code: "invalid_request", message: "fixture failure" } } };
		const observed: StreamEventShape[] = [];
		await assert.rejects(async () => {
			for await (const _ of mapCodexEvents(source([event]), undefined, raw => { observed.push(raw); })) {
				assert.fail("error event must not be yielded");
			}
		}, /fixture failure/);
		assert.deepEqual(observed, [event]);
	});
}

for (const provider of ["openai", "openai-codex"]) {
	for (const transport of ["sse", "websocket"] as const) {
		test(`${provider} ${transport} forwards each provider event with the physical model`, async () => {
			const events = successEvents("resp_events", "hello") as StreamEventShape[];
			events[events.length - 1] = { ...events.at(-1)!, type: "response.done" };
			const server = transport === "websocket" ? await startWebSocketServer([() => events]) : undefined;
			try {
				const model = {
					provider, api: provider === "openai" ? "openai-responses" : "openai-codex-responses",
					id: "gpt-5.5", baseUrl: server?.url ?? "https://example.invalid/v1",
					headers: {}, input: ["text"], reasoning: false,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				};
				const observed: unknown[] = [];
				const stream = createProviderHarness().providers[provider].streamSimple(model, {
					messages: [{ role: "user", content: "fixture", timestamp: 1 }], tools: [],
				}, {
					apiKey: provider === "openai" ? "sk-fixture" : codexJwt(),
					sessionId: `events-${provider}-${transport}`, transport, maxRetries: 0,
					env: { NO_PROXY: "*" },
					fetch: async () => {
						assert.equal(transport, "sse", "WebSocket must not fall back to HTTP");
						return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
					},
					onProviderStreamEvent: async (event: unknown, physicalModel: Model<any>) => {
						await new Promise<void>(resolve => setImmediate(resolve));
						assert.equal(physicalModel.provider, model.provider);
						assert.equal(physicalModel.api, model.api);
						assert.equal(physicalModel.id, model.id);
						observed.push(event);
					},
				});
				const message = await stream.result();
				assert.equal(message.stopReason, "stop", message.errorMessage);
				assert.deepEqual(observed, events);
				assert.deepEqual(message.content.filter((block: { type: string }) => block.type === "text")
					.map((block: { text: string }) => block.text), ["hello"]);
			} finally {
				await server?.close();
			}
		});
	}
}
