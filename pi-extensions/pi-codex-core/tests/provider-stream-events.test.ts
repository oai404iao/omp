import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { mapCodexEvents } from "../src/providers/openai-codex/events.js";
import { ProviderResponseError, WebSocketHandshakeError } from "../src/providers/openai-codex/errors.js";
import { isRetryableWebSocketError, webSocketCompactionRetryDelayMs, webSocketRetryDelayMs } from "../src/providers/openai-codex/retry.js";
import { closeProviderWebSocketSessions } from "../src/providers/openai-codex/websocket-session.js";
import { resetCodexWireState } from "@oai404iao/pi-codex-runtime/internal/codex-wire-identity";
import type { StreamEventShape } from "@oai404iao/pi-codex-runtime/internal/providers/openai-codex/types";
import { createProviderHarness, codexJwt } from "./support/openai-codex-test-support.js";
import { startWebSocketServer, successEvents } from "./support/websocket-test-support.js";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let agentDir: string | undefined;
beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "pi-provider-events-"));
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
	if (agentDir !== undefined) rmSync(agentDir, { recursive: true, force: true });
	agentDir = undefined;
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

for (const type of ["error", "response.failed"]) {
	const eventWithHeaders = (errorHeaders: unknown, eventHeaders: unknown, code = "server_is_overloaded"): StreamEventShape => {
		const error = { code, message: "fixture failure", headers: errorHeaders, type: "server_error", param: "fixture" };
		return type === "error"
			? { type, error, headers: eventHeaders, status_code: 503, sequence_number: 4 }
			: { type, response: { error }, headers: eventHeaders };
	};

	for (const [name, nested, outer, expected] of [
		["nested headers without event headers", { "rEtRy-AfTeR": 0.25 }, undefined, 250],
		["nested seconds over event milliseconds", { "Retry-After": "0" }, { "retry-after-ms": 50 }, 0],
		["nested milliseconds over nested seconds", { "Retry-After": "2", "Retry-After-Ms": " 25.5 " }, { "retry-after-ms": 50 }, 25.5],
		["event headers without nested headers", undefined, { "retry-after-ms": 50 }, 50],
		["invalid nested delay with valid event headers", { "retry-after": "not a delay" }, { "retry-after-ms": "50" }, 50],
		["malformed nested values with valid event headers", { "retry-after-ms": ["10"] }, { "retry-after-ms": 50 }, 50],
		["blank nested delay with valid event headers", { "retry-after-ms": " \t ", "Retry-After": " \t " }, { "retry-after-ms": 50 }, 50],
		["negative nested delay with valid event headers", { "retry-after-ms": -1, "Retry-After": "-1" }, { "retry-after-ms": 50 }, 50],
		["non-decimal nested delay with valid event headers", { "retry-after": "0x10" }, { "retry-after-ms": 50 }, 50],
		["blank nested milliseconds with valid nested seconds", { "retry-after-ms": " ", "Retry-After": ".25" }, { "retry-after-ms": 50 }, 250],
		["nested HTTP date", { "Retry-After": "Sun, 06 Nov 1994 08:49:37 GMT" }, { "retry-after-ms": 50 }, 0],
		["nested RFC 850 date", { "Retry-After": "Sunday, 06-Nov-94 08:49:37 GMT" }, { "retry-after-ms": 50 }, 0],
		["nested asctime date", { "Retry-After": "Sun Nov  6 08:49:37 1994" }, { "retry-after-ms": 50 }, 0],
		["no valid delay", [], { "retry-after-ms": false }, undefined],
	] as const) {
		test(`${type} Retry-After: ${name}`, async () => {
			const events = mapCodexEvents(source([eventWithHeaders(nested, outer)]));
			await assert.rejects(events[Symbol.asyncIterator]().next(), error => {
				assert.ok(error instanceof ProviderResponseError);
				assert.equal(error.retryAfterMs, expected);
				assert.equal(error.code, "server_is_overloaded");
				assert.equal(error.message, type === "error" ? "Codex error: fixture failure" : "fixture failure");
				assert.equal(error.status, type === "error" ? 503 : undefined);
				assert.equal(error.errorType, type === "error" ? "server_error" : undefined);
				assert.equal(Reflect.get(error, "sequenceNumber"), type === "error" ? 4 : undefined);
				assert.equal(Reflect.get(error, "param"), "fixture");
				return true;
			});
		});
	}

	test(`${type} delay is subject to both existing WebSocket retry bounds`, async () => {
		const event = eventWithHeaders({ "retry-after-ms": 40 }, { "retry-after-ms": 0 });
		await assert.rejects(mapCodexEvents(source([event]))[Symbol.asyncIterator]().next(), error => {
			assert.equal(isRetryableWebSocketError(error), true);
			for (const delay of [webSocketRetryDelayMs, webSocketCompactionRetryDelayMs]) {
				assert.equal(delay(error, 1, { maxRetryDelayMs: 50 }), 40);
				assert.throws(() => delay(error, 1, { maxRetryDelayMs: 20 }), /retry delay 40ms exceeds maxRetryDelayMs 20ms/);
			}
			return true;
		});
	});

	test(`${type} Retry-After does not make terminal quota errors retryable`, async () => {
		const event = eventWithHeaders({ "retry-after-ms": 0 }, undefined, "insufficient_quota");
		await assert.rejects(mapCodexEvents(source([event]))[Symbol.asyncIterator]().next(), error => {
			assert.equal(isRetryableWebSocketError(error), false);
			return true;
		});
	});
}

for (const transport of ["sse", "websocket"] as const) {
	test(`${transport} does not replay a started response with Retry-After advice`, async () => {
		const events = [
			{ type: "response.created", response: { id: "resp_started" } },
			{ type: "response.failed", response: { error: { code: "server_is_overloaded", message: "Server overloaded", headers: { "retry-after-ms": 0 } } } },
		];
		const server = transport === "websocket" ? await startWebSocketServer([() => events]) : undefined;
		let httpRequests = 0;
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
				apiKey: "sk-fixture", transport, maxRetries: 1, maxRetryDelayMs: 1, env: { NO_PROXY: "*" },
				fetch: async () => {
					httpRequests++;
					return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
				},
			}).result();
			assert.equal(message.stopReason, "error");
			assert.equal(message.errorMessage, "Server overloaded");
			assert.equal(httpRequests, transport === "sse" ? 1 : 0);
			if (server) assert.equal(server.requests.length, 1);
		} finally {
			await server?.close();
		}
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
