import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resetCodexWireState } from "../src/codex-wire-identity.js";
import { createStartupPrewarmLifecycle } from "../src/extension/startup-prewarm.js";
import { closeProviderWebSocketSessions, websocketHttpFallbackSessions } from "../src/providers/openai-codex/websocket-session.js";
import { deferred, eventContext, responsesModel, withCodexSettings } from "./support/provider-lifecycle-test-support.js";
import { startWebSocketServer, successEvents } from "./support/websocket-test-support.js";

const pi = {
	getActiveTools: () => [],
	getAllTools: () => [],
	getThinkingLevel: () => "medium",
} as unknown as ExtensionAPI;
type Auth = Awaited<ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>>;

afterEach(() => {
	closeProviderWebSocketSessions();
	resetCodexWireState();
});

test("reset detaches pending auth and prevents an old generation from opening sockets", async () => {
	await withCodexSettings({ openaiTransport: "websocket", openaiWebSocketPrewarm: true }, async () => {
		const server = await startWebSocketServer([]);
		const lifecycle = createStartupPrewarmLifecycle(pi);
		try {
			const auth = deferred<Auth>();
			const ctx = eventContext({ ...responsesModel, baseUrl: server.url });
			ctx.modelRegistry.getApiKeyAndHeaders = () => auth.promise;
			lifecycle.reset();
			lifecycle.start(ctx);
			const pending = lifecycle.get("lifecycle-test", ctx.model!);
			assert.ok(pending);
			assert.equal(lifecycle.get("another-session", ctx.model!), undefined);
			assert.equal(lifecycle.get("lifecycle-test", { ...responsesModel, baseUrl: "https://other.test" }), undefined);
			lifecycle.reset();
			assert.equal(lifecycle.get("lifecycle-test", ctx.model!), undefined);
			let timeout: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					pending,
					new Promise<never>((_resolve, reject) => {
						timeout = setTimeout(() => reject(new Error("reset did not release prewarm waiters")), 1_000);
					}),
				]);
			} finally {
				clearTimeout(timeout);
			}
			auth.resolve({ ok: true, apiKey: "test-key" });
			await new Promise(resolve => setImmediate(resolve));
			assert.equal(server.connections, 0);
			assert.equal(server.requests.length, 0);
		} finally {
			lifecycle.reset();
			await server.close();
		}
	});
});

test("late auth rejection is consumed after the prewarm task has been cancelled", async () => {
	await withCodexSettings({ openaiTransport: "websocket", openaiWebSocketPrewarm: true }, async () => {
		const lifecycle = createStartupPrewarmLifecycle(pi);
		const auth = deferred<Auth>();
		const ctx = eventContext();
		ctx.modelRegistry.getApiKeyAndHeaders = () => auth.promise;
		lifecycle.reset();
		lifecycle.start(ctx);
		const pending = lifecycle.get("lifecycle-test", responsesModel);
		assert.ok(pending);
		lifecycle.reset();
		auth.reject(new Error("late refresh failure"));
		await pending;
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(websocketHttpFallbackSessions.size, 0);
	});
});

test("speculative auth failures settle the task rather than leaking a rejection or setting fallback", async () => {
	await withCodexSettings({ openaiTransport: "auto", openaiWebSocketPrewarm: true }, async () => {
		const lifecycle = createStartupPrewarmLifecycle(pi);
		const ctx = eventContext();
		ctx.modelRegistry.getApiKeyAndHeaders = async () => { throw new Error("auth unavailable"); };
		try {
			lifecycle.reset();
			lifecycle.start(ctx);
			const pending = lifecycle.get("lifecycle-test", responsesModel);
			assert.ok(pending);
			await assert.doesNotReject(pending);
			assert.equal(websocketHttpFallbackSessions.size, 0);
		} finally {
			lifecycle.reset();
		}
	});
});

test("ready prewarm remains one-shot and lifecycle instances do not share task ownership", async () => {
	await withCodexSettings({ openaiTransport: "websocket", openaiWebSocketPrewarm: true }, async () => {
		const server = await startWebSocketServer([() => successEvents("resp_prewarm")]);
		const first = createStartupPrewarmLifecycle(pi);
		const second = createStartupPrewarmLifecycle(pi);
		const ctx = eventContext({ ...responsesModel, baseUrl: server.url });
		try {
			first.reset();
			first.start(ctx);
			const pending = first.get("lifecycle-test", ctx.model!);
			assert.ok(pending);
			await pending;
			assert.equal(second.get("lifecycle-test", ctx.model!), undefined);
			second.reset();
			assert.equal(first.get("lifecycle-test", ctx.model!), pending);
			first.start(ctx);
			await first.get("lifecycle-test", ctx.model!);
			assert.equal(server.requests.length, 1);
			assert.equal(server.requests[0].generate, false);
			assert.deepEqual(server.requests[0].input, []);
		} finally {
			first.reset();
			second.reset();
			closeProviderWebSocketSessions();
			await server.close();
		}
	});
});

for (const [name, settings] of [
	["SSE sessions", { openaiTransport: "sse", openaiWebSocketPrewarm: true }],
	["globally disabled WebSocket sessions", { webSocketEnabled: false }],
] as const) {
	test(`${name} do not request auth or start speculative network work`, async () => {
		await withCodexSettings(settings, async () => {
			const lifecycle = createStartupPrewarmLifecycle(pi);
			const ctx = eventContext();
			let authCalls = 0;
			ctx.modelRegistry.getApiKeyAndHeaders = async () => { authCalls++; throw new Error("unexpected auth lookup"); };
			lifecycle.reset();
			try {
				lifecycle.start(ctx);
				await lifecycle.get("lifecycle-test", responsesModel);
				assert.equal(authCalls, 0, "SSE must not prewarm");
			} finally {
				lifecycle.reset();
			}
		});
	});
}
