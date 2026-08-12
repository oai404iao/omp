import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test, { afterEach } from "node:test";
import {
	buildWebSocketHeaders,
	closeProviderWebSocketSessions,
	registerOpenAIResponsesProviders,
	resolveResponsesWebSocketUrl,
} from "../src/provider-shim.js";

const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
	closeProviderWebSocketSessions();
	if (originalPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
});

function writeSettings(value: Record<string, unknown>): void {
	const root = mkdtempSync(join(tmpdir(), "pi-codex-ws-settings-"));
	const agentDir = join(root, "agent");
	const configDir = join(agentDir, "extensions", "pi-codex-minimal-tools");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(configDir, "config.json"), JSON.stringify(value));
	process.env.PI_CODING_AGENT_DIR = agentDir;
}

function createProviderHarness(): Record<string, any> {
	const providers: Record<string, any> = {};
	const pi = {
		registerProvider(name: string, value: any) {
			providers[name] = value;
		},
		on() {},
		registerMessageRenderer() {},
		sendMessage() {},
	};
	registerOpenAIResponsesProviders(pi as any, { getCurrentCwd: () => process.cwd() });
	return providers;
}

function createProviderHarnessWithEvents(): {
	providers: Record<string, any>;
	handlers: Record<string, Array<(event: any, ctx: any) => Promise<void> | void>>;
} {
	const providers: Record<string, any> = {};
	const handlers: Record<string, Array<(event: any, ctx: any) => Promise<void> | void>> = {};
	const pi = {
		registerProvider(name: string, value: any) {
			providers[name] = value;
		},
		on(name: string, handler: (event: any, ctx: any) => Promise<void> | void) {
			(handlers[name] ??= []).push(handler);
		},
		registerMessageRenderer() {},
		sendMessage() {},
	};
	registerOpenAIResponsesProviders(pi as any, { getCurrentCwd: () => process.cwd() });
	return { providers, handlers };
}

function successEvents(responseId: string, text?: string): unknown[] {
	const output = text
		? [{
				type: "message",
				id: `msg_${responseId}`,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text, annotations: [] }],
			}]
		: [];
	return [
		{ type: "response.created", response: { id: responseId } },
		...(text
			? [{
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "message", id: `msg_${responseId}`, role: "assistant", status: "in_progress", content: [] },
				}, {
					type: "response.output_text.delta",
					output_index: 0,
					content_index: 0,
					delta: text,
				}, {
					type: "response.output_item.done",
					output_index: 0,
					item: output[0],
				}]
			: []),
		{
			type: "response.completed",
			response: {
				id: responseId,
				status: "completed",
				output,
				usage: {
					input_tokens: 0,
					output_tokens: 0,
					total_tokens: 0,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		},
	];
}

function encodeServerFrame(payload: string | Buffer, options?: { binary?: boolean }): Buffer {
	const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
	const opcode = options?.binary ? 0x2 : 0x1;
	if (data.length < 126) return Buffer.concat([Buffer.from([0x80 | opcode, data.length]), data]);
	if (data.length <= 0xffff) {
		const header = Buffer.alloc(4);
		header[0] = 0x80 | opcode;
		header[1] = 126;
		header.writeUInt16BE(data.length, 2);
		return Buffer.concat([header, data]);
	}
	throw new Error("Test payload is too large");
}

function encodeServerText(payload: unknown): Buffer {
	return encodeServerFrame(JSON.stringify(payload));
}

function decodeClientFrames(buffer: Uint8Array): { frames: string[]; remaining: Buffer } {
	const source = Buffer.from(buffer);
	const frames: string[] = [];
	let offset = 0;
	while (source.length - offset >= 2) {
		const first = source[offset]!;
		const second = source[offset + 1]!;
		let length = second & 0x7f;
		let headerLength = 2;
		if (length === 126) {
			if (source.length - offset < 4) break;
			length = source.readUInt16BE(offset + 2);
			headerLength = 4;
		} else if (length === 127) {
			throw new Error("Test client frame is too large");
		}
		const masked = (second & 0x80) !== 0;
		const maskLength = masked ? 4 : 0;
		const frameLength = headerLength + maskLength + length;
		if (source.length - offset < frameLength) break;
		const opcode = first & 0x0f;
		const payloadStart = offset + headerLength + maskLength;
		const payload = Buffer.from(source.subarray(payloadStart, payloadStart + length));
		if (masked) {
			const mask = source.subarray(offset + headerLength, offset + headerLength + 4);
			for (let index = 0; index < payload.length; index++) {
				payload[index] ^= mask[index % 4]!;
			}
		}
		if (opcode === 0x1) frames.push(payload.toString("utf8"));
		offset += frameLength;
	}
	return { frames, remaining: Buffer.from(source.subarray(offset)) };
}

type WebSocketResponse = unknown[] | {
	handshakeStatus: number;
	handshakeBody?: unknown;
	handshakeHeaders?: Record<string, string>;
};
type WebSocketResponseSequence = WebSocketResponse | {
	before?: (body: Record<string, any>, socket: import("node:stream").Duplex) => void | Promise<void>;
	events: unknown[];
};

async function startWebSocketServer(
	responses: Array<(request: Record<string, any> | undefined) => WebSocketResponseSequence>,
	onRequest?: RequestListener,
): Promise<{
	url: string;
	requests: Record<string, any>[];
	handshakes: IncomingMessage[];
	connections: number;
	close(): Promise<void>;
}> {
	const requests: Record<string, any>[] = [];
	const handshakes: IncomingMessage[] = [];
	const sockets = new Set<import("node:net").Socket>();
	let connections = 0;
	const server = createServer(onRequest);
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	server.on("upgrade", (request, socket) => {
		connections++;
		handshakes.push(request);
		const response = responses[requests.length];
		assert.ok(response, `Unexpected WebSocket connection ${connections}`);
		const handshakeResponse = response(undefined);
		if (
			!Array.isArray(handshakeResponse)
			&& "handshakeStatus" in handshakeResponse
		) {
			const body = handshakeResponse.handshakeBody === undefined
				? JSON.stringify({ error: { message: "WebSocket unavailable" } })
				: typeof handshakeResponse.handshakeBody === "string"
					? handshakeResponse.handshakeBody
					: JSON.stringify(handshakeResponse.handshakeBody);
			socket.end([
				`HTTP/1.1 ${handshakeResponse.handshakeStatus} Upgrade Required`,
				"Content-Type: application/json",
				"Connection: close",
				...Object.entries(handshakeResponse.handshakeHeaders ?? {}).map(([name, value]) => `${name}: ${value}`),
				"",
				body,
			].join("\r\n"));
			return;
		}
		const key = request.headers["sec-websocket-key"];
		assert.equal(typeof key, "string");
		const accept = createHash("sha1")
			.update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
			.digest("base64");
		socket.write([
			"HTTP/1.1 101 Switching Protocols",
			"Upgrade: websocket",
			"Connection: Upgrade",
			`Sec-WebSocket-Accept: ${accept}`,
			"",
			"",
		].join("\r\n"));

		let buffer: Uint8Array = Buffer.alloc(0);
		socket.on("data", async (chunk) => {
			buffer = Buffer.concat([buffer, chunk]);
			const decoded = decodeClientFrames(buffer);
			buffer = decoded.remaining;
			for (const frame of decoded.frames) {
				const body = JSON.parse(frame) as Record<string, any>;
				const response = responses[requests.length];
				assert.ok(response, `Unexpected WebSocket request ${requests.length + 1}`);
				requests.push(body);
				const sequence = response(body);
				assert.ok(
					Array.isArray(sequence) || !("handshakeStatus" in sequence),
					"Request response must not be a handshake response",
				);
				const events = Array.isArray(sequence) ? sequence : sequence.events;
				if (!Array.isArray(sequence) && sequence.before) {
					await sequence.before(body, socket);
				}
				assert.ok(Array.isArray(events), "Request response must be an event list");
				for (const event of events) {
					if (event && typeof event === "object" && "$rawText" in event) {
						socket.write(encodeServerFrame(String((event as { $rawText: unknown }).$rawText)));
					} else if (event && typeof event === "object" && "$binary" in event) {
						socket.write(encodeServerFrame(
							Buffer.from(String((event as { $binary: unknown }).$binary)),
							{ binary: true },
						));
					} else {
						socket.write(encodeServerText(event));
					}
				}
			}
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address === "object");
	return {
		url: `http://127.0.0.1:${address.port}/v1`,
		requests,
		handshakes,
		get connections() {
			return connections;
		},
		async close() {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve, reject) => {
				server.close((error) => error ? reject(error) : resolve());
			});
		},
	};
}

async function readJsonRequest(request: IncomingMessage, response: ServerResponse): Promise<Record<string, any>> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, any>;
	response.writeHead(200, { "content-type": "text/event-stream" });
	return body;
}

async function runOpenAIProvider(
	provider: any,
	baseUrl: string,
	messages: any[],
	options: Record<string, unknown> = {},
): Promise<any> {
	const stream = provider.streamSimple(
		{
			provider: "openai",
			api: "openai-responses",
			id: "gpt-5.5",
			baseUrl,
			headers: {},
			input: ["text"],
			reasoning: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		},
		{ systemPrompt: "", messages, tools: [] },
		{ apiKey: "pi-resolved-api-key", sessionId: "pi-session", ...options },
	);
	return stream.result();
}

test("OpenAI WebSocket URL and headers use the normal Responses endpoint and Pi auth", () => {
	assert.equal(
		resolveResponsesWebSocketUrl("https://api.openai.com/v1", { apiKeyMode: true }),
		"wss://api.openai.com/v1/responses",
	);
	const headers = buildWebSocketHeaders(
		{ "x-model": "model" },
		{ "x-pi-auth": "resolved" },
		undefined,
		"pi-key",
		"pi-session",
	);
	assert.equal(headers.get("authorization"), "Bearer pi-key");
	assert.equal(headers.get("x-pi-auth"), "resolved");
	assert.equal(headers.get("chatgpt-account-id"), null);
	assert.equal(headers.get("openai-beta"), "responses_websockets=2026-02-06");
	assert.equal(headers.get("session-id"), "pi-session");
	assert.equal(headers.get("thread-id"), "pi-session");
	assert.equal(headers.get("x-client-request-id"), "pi-session");
});

test("openai websocket transport performs an authenticated response.create request", async () => {
	writeSettings({ openaiTransport: "websocket" });
	const server = await startWebSocketServer([
		() => successEvents("resp_1", "hello over websocket"),
	]);
	try {
		const provider = createProviderHarness().openai;
		const result = await runOpenAIProvider(provider, server.url, [{ role: "user", content: "hello" }], {
			headers: { "x-pi-auth": "resolved" },
		});

		assert.equal(result.stopReason, "stop");
		assert.equal(result.content[0]?.text, "hello over websocket");
		assert.equal(server.connections, 1);
		assert.equal(server.requests.length, 1);
		assert.equal(server.requests[0]?.type, "response.create");
		assert.equal(server.requests[0]?.model, "gpt-5.5");
		assert.equal(server.requests[0]?.client_metadata?.session_id, "pi-session");
		assert.equal(server.requests[0]?.client_metadata?.thread_id, "pi-session");
		assert.equal(typeof server.requests[0]?.client_metadata?.turn_id, "string");
		assert.match(server.requests[0]?.client_metadata?.["x-codex-ws-stream-request-start-ms"], /^\d+$/);
		assert.equal(server.handshakes[0]?.headers.authorization, "Bearer pi-resolved-api-key");
		assert.equal(server.handshakes[0]?.headers["x-pi-auth"], "resolved");
		assert.equal(server.handshakes[0]?.headers["openai-beta"], "responses_websockets=2026-02-06");
		assert.equal(server.handshakes[0]?.headers["session-id"], "pi-session");
		assert.equal(server.handshakes[0]?.headers["thread-id"], "pi-session");
	} finally {
		await server.close();
	}
});

test("explicit Pi request metadata supplies the WebSocket turn identity", async () => {
	writeSettings({ openaiTransport: "websocket" });
	const server = await startWebSocketServer([
		() => successEvents("resp_1", "ok"),
	]);
	try {
		const provider = createProviderHarness().openai;
		const result = await runOpenAIProvider(provider, server.url, [{ role: "user", content: "hello" }], {
			metadata: {
				session_id: "pi-session-metadata",
				thread_id: "pi-thread",
				turn_id: "pi-turn",
			},
		});

		assert.equal(result.stopReason, "stop");
		assert.equal(server.handshakes[0]?.headers["session-id"], "pi-session-metadata");
		assert.equal(server.handshakes[0]?.headers["thread-id"], "pi-thread");
		assert.equal(server.handshakes[0]?.headers["x-client-request-id"], "pi-thread");
		assert.equal(server.requests[0]?.client_metadata?.session_id, "pi-session-metadata");
		assert.equal(server.requests[0]?.client_metadata?.thread_id, "pi-thread");
		assert.equal(server.requests[0]?.client_metadata?.turn_id, "pi-turn");
	} finally {
		await server.close();
	}
});

test("Pi agent lifecycle keeps one turn_id across tool-loop and automatic retry requests", async () => {
	writeSettings({ openaiTransport: "websocket" });
	const server = await startWebSocketServer([
		() => successEvents("resp_1", "first"),
		() => successEvents("resp_2", "second"),
		() => successEvents("resp_3", "third"),
	]);
	try {
		const harness = createProviderHarnessWithEvents();
		const ctx = { sessionManager: { getSessionId: () => "pi-session" } };
		for (const handler of harness.handlers.before_agent_start ?? []) {
			await handler({ type: "before_agent_start", prompt: "hello" }, ctx);
		}

		await runOpenAIProvider(harness.providers.openai, server.url, [{ role: "user", content: "hello" }]);
		await runOpenAIProvider(harness.providers.openai, server.url, [{ role: "user", content: "again" }]);

		const firstTurnId = server.requests[0]?.client_metadata?.turn_id;
		const secondTurnId = server.requests[1]?.client_metadata?.turn_id;
		assert.equal(typeof firstTurnId, "string");
		assert.equal(secondTurnId, firstTurnId);

		for (const handler of harness.handlers.agent_end ?? []) {
			await handler({ type: "agent_end", messages: [] }, ctx);
		}
		await runOpenAIProvider(harness.providers.openai, server.url, [{ role: "user", content: "automatic retry" }]);
		assert.equal(server.requests[2]?.client_metadata?.turn_id, firstTurnId);
	} finally {
		await server.close();
	}
});

test("Pi-resolved Authorization header overrides the fallback API key", async () => {
	writeSettings({ openaiTransport: "websocket" });
	const server = await startWebSocketServer([
		() => successEvents("resp_1", "ok"),
	]);
	try {
		const provider = createProviderHarness().openai;
		const result = await runOpenAIProvider(provider, server.url, [{ role: "user", content: "hello" }], {
			headers: { Authorization: "Bearer pi-header-token" },
		});

		assert.equal(result.stopReason, "stop");
		assert.equal(server.handshakes[0]?.headers.authorization, "Bearer pi-header-token");
	} finally {
		await server.close();
	}
});

test("Pi-resolved Authorization header can authenticate without an API-key value", async () => {
	writeSettings({ openaiTransport: "websocket" });
	const server = await startWebSocketServer([
		() => successEvents("resp_1", "ok"),
	]);
	try {
		const provider = createProviderHarness().openai;
		const stream = provider.streamSimple(
			{
				provider: "openai",
				api: "openai-responses",
				id: "gpt-5.5",
				baseUrl: server.url,
				headers: {},
				input: ["text"],
				reasoning: false,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
			{ systemPrompt: "", messages: [{ role: "user", content: "hello" }], tools: [] },
			{
				headers: { Authorization: "Bearer pi-header-token" },
				sessionId: "pi-session",
			},
		);
		const result = await stream.result();

		assert.equal(result.stopReason, "stop");
		assert.equal(server.handshakes[0]?.headers.authorization, "Bearer pi-header-token");
	} finally {
		await server.close();
	}
});

test("model Authorization does not override Pi's resolved API key", async () => {
	writeSettings({ openaiTransport: "websocket" });
	const server = await startWebSocketServer([
		() => successEvents("resp_1", "ok"),
	]);
	try {
		const provider = createProviderHarness().openai;
		const stream = provider.streamSimple(
			{
				provider: "openai",
				api: "openai-responses",
				id: "gpt-5.5",
				baseUrl: server.url,
				headers: { Authorization: "Bearer stale-model-token" },
				input: ["text"],
				reasoning: false,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
			{ systemPrompt: "", messages: [{ role: "user", content: "hello" }], tools: [] },
			{ apiKey: "pi-resolved-api-key", sessionId: "pi-session" },
		);
		const result = await stream.result();

		assert.equal(result.stopReason, "stop");
		assert.equal(server.handshakes[0]?.headers.authorization, "Bearer pi-resolved-api-key");
	} finally {
		await server.close();
	}
});

test("openai websocket reconnects once when the server reports its connection limit", async () => {
	writeSettings({ openaiTransport: "websocket" });
	const server = await startWebSocketServer([
		() => [{
			type: "error",
			status: 400,
			error: {
				type: "invalid_request_error",
				code: "websocket_connection_limit_reached",
				message: "Create a new WebSocket connection to continue.",
			},
		}],
		() => successEvents("resp_2", "reconnected"),
	]);
	try {
		const provider = createProviderHarness().openai;
		const result = await runOpenAIProvider(provider, server.url, [{ role: "user", content: "hello" }]);

		assert.equal(result.stopReason, "stop");
		assert.equal(result.content[0]?.text, "reconnected");
		assert.equal(server.connections, 2);
		assert.equal(server.requests.length, 2);
	} finally {
		await server.close();
	}
});

test("openai websocket-cached reuses the connection and sends an incremental input delta", async () => {
	writeSettings({ openaiTransport: "websocket-cached" });
	const server = await startWebSocketServer([
		() => successEvents("resp_1", "first"),
		() => successEvents("resp_2", "second"),
	]);
	try {
		const provider = createProviderHarness().openai;
		const first = await runOpenAIProvider(provider, server.url, [{ role: "user", content: "hello" }]);
		assert.equal(first.stopReason, "stop");
		const second = await runOpenAIProvider(provider, server.url, [
			{ role: "user", content: "hello" },
			first,
			{ role: "user", content: "again" },
		]);
		assert.equal(second.stopReason, "stop");

		assert.equal(server.connections, 1);
		assert.equal(server.requests.length, 2);
		assert.equal(server.requests[1]?.previous_response_id, "resp_1");
		assert.equal(server.requests[1]?.input.length, 1);
		assert.equal(server.requests[1]?.input[0]?.role, "user");
		assert.equal(server.requests[1]?.input[0]?.content[0]?.text, "again");
	} finally {
		await server.close();
	}
});

test("openai websocket preserves HTTP status and usage-limit details from error envelopes", async () => {
	writeSettings({ openaiTransport: "websocket" });
	const server = await startWebSocketServer([
		() => [{
			type: "error",
			status_code: 429,
			error: {
				type: "usage_limit_reached",
				plan_type: "PRO",
				message: "quota exceeded",
			},
		}],
	]);
	try {
		const provider = createProviderHarness().openai;
		const result = await runOpenAIProvider(provider, server.url, [{ role: "user", content: "hello" }]);

		assert.equal(result.stopReason, "error");
		assert.equal(result.errorMessage, "HTTP 429: You have hit your OpenAI usage limit (pro plan).");
		assert.equal(server.requests.length, 1);
	} finally {
		await server.close();
	}
});

test("openai auto falls back to SSE when the WebSocket handshake fails", async () => {
	writeSettings({ openaiTransport: "auto" });
	let sseRequestBody: any;
	const sseEvents = successEvents("resp_sse", "fell back");
	const server = await startWebSocketServer([
		() => ({ handshakeStatus: 426 }),
	], (request, response) => {
		if (request.method !== "POST" || request.url !== "/v1/responses") {
			response.writeHead(404).end();
			return;
		}
		const chunks: Buffer[] = [];
		request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
		request.on("end", () => {
			sseRequestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			response.writeHead(200, { "content-type": "text/event-stream" });
			for (const item of sseEvents) {
				response.write(`data: ${JSON.stringify(item)}\n\n`);
			}
			response.end();
		});
	});
	try {
		const provider = createProviderHarness().openai;
		const result = await runOpenAIProvider(provider, server.url, [{ role: "user", content: "hello" }]);
		assert.equal(result.stopReason, "stop");
		assert.equal(result.content[0]?.text, "fell back");
		assert.equal(sseRequestBody.model, "gpt-5.5");
	} finally {
		await server.close();
	}
});

test("openai auto does not fall back after the WebSocket stream has started", async () => {
	writeSettings({ openaiTransport: "auto" });
	const server = await startWebSocketServer([
		() => [{
			type: "response.created",
			response: { id: "resp_partial" },
		}, {
			type: "response.failed",
			response: { error: { code: "invalid_prompt", message: "synthetic failure" } },
		}],
	]);
	try {
		const provider = createProviderHarness().openai;
		const result = await runOpenAIProvider(provider, server.url, [{ role: "user", content: "hello" }]);
		assert.equal(result.stopReason, "error");
		assert.equal(result.errorMessage, "synthetic failure");
		assert.equal(server.requests.length, 1);
	} finally {
		await server.close();
	}
});

test("openai websocket-cached retries a missing previous response with full context", async () => {
	writeSettings({ openaiTransport: "websocket-cached" });
	const server = await startWebSocketServer([
		() => successEvents("resp_1", "first"),
		() => [{
			type: "error",
			status: 400,
			error: {
				type: "invalid_request_error",
				code: "previous_response_not_found",
				message: "Previous response was not found.",
			},
		}],
		() => successEvents("resp_2", "second"),
	]);
	try {
		const provider = createProviderHarness().openai;
		const first = await runOpenAIProvider(provider, server.url, [{ role: "user", content: "hello" }]);
		const second = await runOpenAIProvider(provider, server.url, [
			{ role: "user", content: "hello" },
			first,
			{ role: "user", content: "again" },
		]);
		assert.equal(second.stopReason, "stop");

		assert.equal(server.connections, 2);
		assert.equal(server.requests[1]?.previous_response_id, "resp_1");
		assert.equal(server.requests[2]?.previous_response_id, undefined);
		assert.equal(server.requests[2]?.input.length, 3);
	} finally {
		await server.close();
	}
});

test("openai auto retries WebSocket failures and keeps session-level SSE fallback sticky", async () => {
	writeSettings({ openaiTransport: "auto" });
	const sseEvents = [
		successEvents("resp_sse_1", "first over sse"),
		successEvents("resp_sse_2", "second over sse"),
	];
	let sseRequests = 0;
	const server = await startWebSocketServer([
		() => ({ handshakeStatus: 503, handshakeBody: { error: { message: "temporarily unavailable" } } }),
		() => ({ handshakeStatus: 503, handshakeBody: { error: { message: "temporarily unavailable" } } }),
	], (request, response) => {
		if (request.method !== "POST" || request.url !== "/v1/responses") {
			response.writeHead(404).end();
			return;
		}
		request.resume();
		request.on("end", () => {
			const events = sseEvents[sseRequests++];
			assert.ok(events);
			response.writeHead(200, { "content-type": "text/event-stream" });
			for (const item of events) response.write(`data: ${JSON.stringify(item)}\n\n`);
			response.end();
		});
	});
	try {
		const provider = createProviderHarness().openai;
		const first = await runOpenAIProvider(provider, server.url, [{ role: "user", content: "first" }], {
			maxRetries: 1,
			maxRetryDelayMs: 1_000,
		});
		const second = await runOpenAIProvider(provider, server.url, [{ role: "user", content: "second" }], {
			maxRetries: 1,
			maxRetryDelayMs: 1_000,
		});

		assert.equal(first.content[0]?.text, "first over sse");
		assert.equal(second.content[0]?.text, "second over sse");
		assert.equal(server.connections, 2);
		assert.equal(sseRequests, 2);
	} finally {
		await server.close();
	}
});

test("openai auto switches immediately on HTTP 426 and remembers the fallback", async () => {
	writeSettings({ openaiTransport: "auto" });
	let sseRequests = 0;
	const server = await startWebSocketServer([
		() => ({ handshakeStatus: 426 }),
	], (request, response) => {
		if (request.method !== "POST" || request.url !== "/v1/responses") {
			response.writeHead(404).end();
			return;
		}
		request.resume();
		request.on("end", () => {
			sseRequests++;
			response.writeHead(200, { "content-type": "text/event-stream" });
			for (const item of successEvents(`resp_sse_${sseRequests}`, `sse ${sseRequests}`)) {
				response.write(`data: ${JSON.stringify(item)}\n\n`);
			}
			response.end();
		});
	});
	try {
		const provider = createProviderHarness().openai;
		await runOpenAIProvider(provider, server.url, [{ role: "user", content: "first" }]);
		await runOpenAIProvider(provider, server.url, [{ role: "user", content: "second" }]);
		assert.equal(server.connections, 1);
		assert.equal(sseRequests, 2);
	} finally {
		await server.close();
	}
});

test("openai websocket-cached uses exact server output items and ignores internal metadata", async () => {
	writeSettings({ openaiTransport: "websocket-cached" });
	const serverItem = {
		type: "message",
		id: "msg_server",
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text: "assistant output", annotations: [] }],
	};
	const server = await startWebSocketServer([
		() => [
			{ type: "response.created", response: { id: "resp_1" } },
			{ type: "response.output_item.added", output_index: 0, item: { ...serverItem, status: "in_progress", content: [] } },
			{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "assistant output" },
			{ type: "response.output_item.done", output_index: 0, item: serverItem },
			{
				type: "response.completed",
				response: {
					id: "resp_1",
					status: "completed",
					output: [serverItem],
					usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0 } },
				},
			},
		],
		() => successEvents("resp_2", "continued"),
	]);
	try {
		const provider = createProviderHarness().openai;
		const first = await runOpenAIProvider(provider, server.url, [{ role: "user", content: "hello" }]);
		const replayItem = JSON.parse(first.content[0]?.textSignature).item;
		replayItem.internal_chat_message_metadata_passthrough = { turn_id: "pi-turn" };
		first.content[0].textSignature = JSON.stringify({ v: 2, item: replayItem });
		const second = await runOpenAIProvider(provider, server.url, [
			{ role: "user", content: "hello" },
			first,
			{ role: "user", content: "again" },
		]);

		assert.equal(second.stopReason, "stop");
		assert.equal(server.requests[1]?.previous_response_id, "resp_1");
		assert.equal(server.requests[1]?.input.length, 1);
		assert.equal(server.requests[1]?.input[0]?.content[0]?.text, "again");
	} finally {
		await server.close();
	}
});

test("openai websocket strips unprefixed response item ids without mutating request context", async () => {
	writeSettings({ openaiTransport: "websocket" });
	const server = await startWebSocketServer([
		() => successEvents("resp_1", "ok"),
	]);
	const assistant = {
		role: "assistant",
		content: [{
			type: "text",
			text: "legacy",
			textSignature: JSON.stringify({
				v: 2,
				item: {
					type: "message",
					id: "legacy-id",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "legacy", annotations: [] }],
				},
			}),
		}],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5.5",
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
	};
	try {
		const provider = createProviderHarness().openai;
		await runOpenAIProvider(provider, server.url, [
			{ role: "user", content: "hello" },
			assistant,
			{ role: "user", content: "again" },
		]);
		assert.equal(server.requests[0]?.input[1]?.id, undefined);
		assert.equal(JSON.parse(assistant.content[0].textSignature).item.id, "legacy-id");
	} finally {
		await server.close();
	}
});

test("openai websocket ignores malformed text frames and completes", async () => {
	writeSettings({ openaiTransport: "websocket" });
	const server = await startWebSocketServer([
		() => [{ $rawText: "not json" }, ...successEvents("resp_1", "ok")],
	]);
	try {
		const provider = createProviderHarness().openai;
		const result = await runOpenAIProvider(provider, server.url, [{ role: "user", content: "hello" }]);
		assert.equal(result.stopReason, "stop");
		assert.equal(result.content[0]?.text, "ok");
	} finally {
		await server.close();
	}
});

test("openai websocket rejects binary response frames", async () => {
	writeSettings({ openaiTransport: "websocket" });
	const server = await startWebSocketServer([
		() => [{ $binary: "{\"type\":\"response.completed\"}" }],
	]);
	try {
		const provider = createProviderHarness().openai;
		const result = await runOpenAIProvider(provider, server.url, [{ role: "user", content: "hello" }]);
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage, /Unexpected binary OpenAI Responses WebSocket event/);
	} finally {
		await server.close();
	}
});

test("openai websocket serializes concurrent requests on one session connection", async () => {
	writeSettings({ openaiTransport: "websocket" });
	const server = await startWebSocketServer([
		() => ({
			async before() {
				await new Promise((resolve) => setTimeout(resolve, 30));
			},
			events: successEvents("resp_1", "first"),
		}),
		() => successEvents("resp_2", "second"),
	]);
	try {
		const provider = createProviderHarness().openai;
		const [first, second] = await Promise.all([
			runOpenAIProvider(provider, server.url, [{ role: "user", content: "first" }]),
			runOpenAIProvider(provider, server.url, [{ role: "user", content: "second" }]),
		]);
		assert.equal(first.content[0]?.text, "first");
		assert.equal(second.content[0]?.text, "second");
		assert.equal(server.connections, 1);
		assert.equal(server.requests.length, 2);
	} finally {
		await server.close();
	}
});

test("openai WebSocket prewarm sends generate:false and the first request reuses it", async () => {
	writeSettings({ openaiTransport: "websocket-cached", openaiWebSocketPrewarm: true });
	const server = await startWebSocketServer([
		() => successEvents("warm_1"),
		() => successEvents("resp_1", "real response"),
	]);
	try {
		const harness = createProviderHarnessWithEvents();
		const model = {
			provider: "openai",
			api: "openai-responses",
			id: "gpt-5.5",
			baseUrl: server.url,
			headers: {},
			input: ["text"],
			reasoning: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		const ctx = {
			cwd: process.cwd(),
			model,
			signal: undefined,
			sessionManager: { getSessionId: () => "pi-session" },
			modelRegistry: {
				async getApiKeyAndHeaders() {
					return { ok: true, apiKey: "pi-resolved-api-key" };
				},
			},
		};
		for (const handler of harness.handlers.before_agent_start ?? []) {
			await handler({
				type: "before_agent_start",
				prompt: "hello",
				systemPrompt: "",
				images: undefined,
			}, ctx);
		}
		const result = await runOpenAIProvider(harness.providers.openai, server.url, [{ role: "user", content: "hello" }]);

		assert.equal(result.content[0]?.text, "real response");
		assert.equal(server.connections, 1);
		assert.equal(server.requests[0]?.generate, false);
		assert.equal(server.requests[1]?.previous_response_id, "warm_1");
		assert.deepEqual(server.requests[1]?.input, []);
	} finally {
		await server.close();
	}
});
