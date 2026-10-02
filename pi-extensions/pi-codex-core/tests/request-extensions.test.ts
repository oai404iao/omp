import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { registerNativeCompaction } from "../src/native-compaction.js";
import { closeProviderWebSocketSessions } from "../src/providers/openai-codex/websocket-session.js";
import { codexWireIdentityCount, resetCodexWireState } from "@oai404iao/pi-codex-runtime/internal/codex-wire-identity";
import { updateConfig } from "@oai404iao/pi-codex-runtime/internal/settings";
import { withCodexSettings, responsesModel, createAssistantMessage } from "../../../tests/codex/support/provider-lifecycle-test-support.js";
import { createProviderHarness } from "./support/openai-codex-test-support.js";
import { startWebSocketServer, successEvents } from "./support/websocket-test-support.js";
import { clearEndpointFailures, endpointWasRejected, rememberResolvedEndpoint, reportEndpointFailure, watchEndpointFailures } from "@oai404iao/pi-codex-runtime/internal/endpoint-state";
import { mapCodexEvents } from "../src/providers/openai-codex/events.js";

afterEach(() => { closeProviderWebSocketSessions(); resetCodexWireState(); });

test("wire-off WebSocket frames have no generated metadata and do not share enhanced continuation", () =>
	withCodexSettings({ codexRequestExtensions: false, openaiTransport: "websocket", compactionMode: "pi" }, async cwd => {
		resetCodexWireState();
		const server = await startWebSocketServer([
			() => successEvents("off-1"), () => successEvents("on-2"), () => successEvents("off-3"),
		]);
		const harness = createProviderHarness({ cwd });
		const model = { ...responsesModel, provider: "openai", api: "openai-responses", baseUrl: server.url };
		const send = () => harness.providers.openai.streamSimple(model, {
			messages: [{ role: "user", content: "fixture", timestamp: 1 }], tools: [],
		}, { apiKey: "sk-fixture", sessionId: "wire-mode-test", maxRetries: 0 }).result();
		try {
			const first = await send();
			assert.equal(first.stopReason, "stop", first.errorMessage);
			assert.equal(server.requests[0].client_metadata, undefined);
			assert.equal(server.requests[0].prompt_cache_key, "wire-mode-test");
			assert.equal(codexWireIdentityCount(), 0);
			assert.equal(server.handshakes[0].headers["x-codex-turn-metadata"], undefined);
			updateConfig({ codexRequestExtensions: true });
			assert.equal((await send()).stopReason, "stop");
			assert(server.requests[1].client_metadata);
			assert.equal(server.requests[1].previous_response_id, undefined);
			assert.equal(server.connections, 2);
			updateConfig({ codexRequestExtensions: false });
			assert.equal((await send()).stopReason, "stop");
			assert.equal(server.requests[2].client_metadata, undefined);
			assert.notEqual(server.requests[2].previous_response_id, "on-2");
		} finally { closeProviderWebSocketSessions(); await server.close(); }
	}));

test("wire-off refuses Lite before network side effects", () =>
	withCodexSettings({ codexRequestExtensions: false, webSocketEnabled: false }, async cwd => {
		const harness = createProviderHarness({ cwd });
		let requests = 0;
		const message = await harness.providers.openai.streamSimple({
			...responsesModel, provider: "openai", api: "openai-responses", id: "gpt-5.6-sol",
		}, { messages: [], tools: [] }, {
			apiKey: "fixture", fetch: async () => { requests++; throw new Error("unexpected"); },
		}).result();
		assert.equal(message.stopReason, "error");
		assert.match(message.errorMessage, /Lite requires/);
		assert.equal(requests, 0);
	}));

test("fresh-session opaque replay is checked again after authentication resolves a denied endpoint", () =>
	withCodexSettings({ webSocketEnabled: false, endpoint_config: [{
		provider: "openai", baseUrl: "https://authenticated.invalid/v1", compaction: [],
	}] }, async cwd => {
		const model = { ...responsesModel, provider: "openai", api: "openai-responses" as const, baseUrl: "https://authenticated.invalid/v1" };
		const harness = createProviderHarness({ cwd });
		const message = createAssistantMessage(model);
		message.content = [{ type: "thinking", thinking: "", thinkingSignature: JSON.stringify({ type: "compaction", encrypted_content: "opaque" }) }];
		let requests = 0;
		const result = await harness.providers.openai.streamSimple(model, {
			messages: [{ role: "user", content: "fixture", timestamp: 1 }, message], tools: [],
		}, { apiKey: "fixture", fetch: async () => { requests++; throw new Error("unexpected"); } }).result();
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage, /Opaque checkpoint preserved/);
		assert.equal(requests, 0);
	}));

for (const version of [1, 2, 3, 4]) for (const wireOff of [true, false]) test(`policy protects opaque checkpoint v${version} (wireOff=${wireOff})`, () =>
	withCodexSettings({ codexRequestExtensions: !wireOff, endpoint_config: [{
		provider: "openai", baseUrl: "https://fixture.invalid/v1", compaction: [],
	}] }, async cwd => {
		const handlers: Record<string, Function> = {};
		registerNativeCompaction({ on: (name: string, fn: Function) => { handlers[name] = fn; } } as any);
		const branch = [{
			type: "compaction", id: "checkpoint", parentId: null, timestamp: new Date().toISOString(),
			summary: "placeholder", firstKeptEntryId: null, tokensBefore: 10,
			details: { kind: "openai-native-compaction", version, mode: "responses", provider: "openai", api: "openai-responses",
				model: "gpt-5.5", checkpointId: "checkpoint", output: [{ type: "compaction", encrypted_content: "opaque" }] },
		}];
		let aborted = false;
		const ctx = {
			cwd, model: { ...responsesModel, provider: "openai", api: "openai-responses", id: "gpt-5.5", baseUrl: "https://fixture.invalid/v1" },
			sessionManager: { getSessionId: () => "checkpoint-test", getBranch: () => branch },
			abort() { aborted = true; }, ui: { notify() {} },
		};
		const stop = watchEndpointFailures("checkpoint-test", () => {});
		try {
			rememberResolvedEndpoint(ctx.model, ctx.model, "checkpoint-test");
			const result = handlers.context({ messages: [] }, ctx);
			assert.equal(aborted, true);
			assert.deepEqual(result, { messages: [] });
			assert.deepEqual(await handlers.session_before_compact({ branchEntries: branch }, ctx), { cancel: true });
			assert.equal(branch[0].details.output[0].encrypted_content, "opaque");
		} finally { stop(); clearEndpointFailures("checkpoint-test"); }
	}));

test("streamed unsupported compaction parameters retain attribution for transient disable", async () => {
	const model = { provider: "openai", baseUrl: "https://fixture.invalid/v1" };
	const stop = watchEndpointFailures("stream-error-test", () => {});
	try {
		async function* events() {
			yield { type: "error", error: { code: "unsupported_parameter", param: "compaction_trigger", message: "Unsupported parameter" } };
		}
		await assert.rejects(async () => {
			try { for await (const _event of mapCodexEvents(events())) { /* no successful events */ } }
			catch (error) {
				reportEndpointFailure(model, "stream-error-test", ["compaction.responses"], error);
				throw error;
			}
		}, /Unsupported parameter/);
		assert.equal(endpointWasRejected(model, "stream-error-test", "compaction.responses"), true);
	} finally { stop(); clearEndpointFailures("stream-error-test"); }
});
