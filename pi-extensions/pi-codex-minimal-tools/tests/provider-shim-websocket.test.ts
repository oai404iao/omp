import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type RequestListener } from "node:http";
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

function encodeServerText(payload: unknown): Buffer {
	const data = Buffer.from(JSON.stringify(payload));
	if (data.length < 126) return Buffer.concat([Buffer.from([0x81, data.length]), data]);
	if (data.length <= 0xffff) {
		const header = Buffer.alloc(4);
		header[0] = 0x81;
		header[1] = 126;
		header.writeUInt16BE(data.length, 2);
		return Buffer.concat([header, data]);
	}
	throw new Error("Test payload is too large");
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

type WebSocketResponse = unknown[] | { handshakeStatus: number };

async function startWebSocketServer(
	responses: Array<(request: Record<string, any> | undefined) => WebSocketResponse>,
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
		if (!Array.isArray(handshakeResponse)) {
			socket.end([
				`HTTP/1.1 ${handshakeResponse.handshakeStatus} Upgrade Required`,
				"Content-Type: application/json",
				"Connection: close",
				"",
				JSON.stringify({ error: { message: "WebSocket unavailable" } }),
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
		socket.on("data", (chunk) => {
			buffer = Buffer.concat([buffer, chunk]);
			const decoded = decodeClientFrames(buffer);
			buffer = decoded.remaining;
			for (const frame of decoded.frames) {
				const body = JSON.parse(frame) as Record<string, any>;
				const response = responses[requests.length];
				assert.ok(response, `Unexpected WebSocket request ${requests.length + 1}`);
				requests.push(body);
				const events = response(body);
				assert.ok(Array.isArray(events), "Request response must be an event list");
				for (const event of events) socket.write(encodeServerText(event));
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

test("Pi agent lifecycle keeps one turn_id across tool-loop WebSocket requests", async () => {
	writeSettings({ openaiTransport: "websocket" });
	const server = await startWebSocketServer([
		() => successEvents("resp_1", "first"),
		() => successEvents("resp_2", "second"),
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
