import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installFastModeLifecycle, setSessionFastMode } from "@oai404iao/pi-codex-runtime/internal/fast-mode-state";
import { loadModelSettings } from "@oai404iao/pi-codex-runtime/internal/model-catalog/runtime";
import { requestOpenAINativeCompaction } from "@oai404iao/pi-codex-core/internal/adapter/compaction/request";
import { createStartupPrewarmLifecycle } from "@oai404iao/pi-codex-core/internal/extension/startup-prewarm";
import { closeProviderWebSocketSessions } from "@oai404iao/pi-codex-core/internal/providers/openai-codex/websocket-session";
import { deferred, eventContext, responsesModel, withCodexSettings } from "../../../tests/codex/support/provider-lifecycle-test-support.js";
import { createProviderHarness } from "./support/openai-codex-test-support.js";
import { startWebSocketServer, successEvents } from "./support/websocket-test-support.js";

function fastSession(parent?: SessionManager) {
	const manager = SessionManager.inMemory();
	const handlers: Record<string, Function[]> = {};
	const pi = {
		appendEntry: (type: string, data: unknown) => manager.appendCustomEntry(type, data),
		on: (event: string, handler: Function) => { (handlers[event] ??= []).push(handler); },
	} as unknown as ExtensionAPI;
	installFastModeLifecycle(pi, parent);
	for (const handler of handlers.session_start ?? []) handler({}, { sessionManager: manager });
	return {
		manager, id: manager.getSessionId(),
		set: (enabled: boolean) => setSessionFastMode(pi, manager, enabled),
		close: () => { for (const handler of handlers.session_shutdown ?? []) handler({}); },
	};
}

const compactItem = { type: "compaction", encrypted_content: "fixture" };
function response() {
	return new Response(`data: ${JSON.stringify({
		type: "response.completed",
		response: { id: "fixture", status: "completed", output: [compactItem] },
	})}\n\n`);
}

test("stream and native compaction use live inherited Fast without changing requests already sent", async () => {
	await withCodexSettings({ fastMode: false, openaiTransport: "sse", compactionMode: "responses" }, async () => {
		const root = fastSession();
		const child = fastSession(root.manager);
		const independent = fastSession();
		const previousFetch = globalThis.fetch;
		const bodies: Record<string, unknown>[] = [];
		const pending = deferred<Response>();
		const sent = deferred<void>();
		globalThis.fetch = async (_url, init) => {
			bodies.push(JSON.parse(String(init?.body)));
			if (bodies.length === 1) { sent.resolve(); return pending.promise; }
			return response();
		};
		try {
			const provider = createProviderHarness().providers.openai;
			const context = { systemPrompt: "", messages: [], tools: [] };
			const run = async (sessionId: string, serviceTier?: string, model = responsesModel) => {
				const stream = provider.streamSimple(model, context, { apiKey: "fixture", sessionId, serviceTier });
				const result = await stream.result();
				assert.equal(result.stopReason, "stop", result.errorMessage);
			};
			root.set(true);
			const first = run(child.id);
			await sent.promise;
			root.set(false);
			pending.resolve(response());
			await first;
			assert.equal(bodies[0].service_tier, "priority");
			await run(child.id);
			assert.equal(bodies.at(-1)?.service_tier, undefined);
			root.set(true);
			await run(child.id);
			assert.equal(bodies.at(-1)?.service_tier, "priority");
			await run(independent.id);
			assert.equal(bodies.at(-1)?.service_tier, undefined);
			await run(child.id, "flex");
			assert.equal(bodies.at(-1)?.service_tier, "flex");
			await run(child.id, undefined, { ...responsesModel, id: "gpt-5.4-mini" });
			assert.equal(bodies.at(-1)?.service_tier, undefined);

			const settings = loadModelSettings(responsesModel, undefined, undefined, child.id);
			for (const enabled of [false, true]) {
				root.set(enabled);
				await requestOpenAINativeCompaction(responsesModel, context, {
					mode: "responses", apiKey: "fixture", sessionId: child.id, settings,
				});
				assert.equal(bodies.at(-1)?.service_tier, enabled ? "priority" : undefined);
			}
		} finally {
			globalThis.fetch = previousFetch;
			child.close(); independent.close(); root.close();
		}
	});
});

test("startup prewarm uses the restored session Fast selection", async () => {
	await withCodexSettings({ fastMode: false, openaiTransport: "websocket" }, async () => {
		const root = fastSession();
		root.set(true);
		const server = await startWebSocketServer([() => successEvents("prewarm-fast")]);
		const pi = {
			getActiveTools: () => [], getAllTools: () => [], getThinkingLevel: () => "off",
		} as unknown as ExtensionAPI;
		const lifecycle = createStartupPrewarmLifecycle(pi);
		const ctx = eventContext({ ...responsesModel, baseUrl: server.url }, root.id);
		try {
			lifecycle.start(ctx);
			await lifecycle.get(root.id, ctx.model!);
			assert.equal(server.requests.length, 1);
			assert.equal(server.requests[0].service_tier, "priority");
		} finally {
			lifecycle.reset();
			closeProviderWebSocketSessions();
			await server.close();
			root.close();
		}
	});
});
