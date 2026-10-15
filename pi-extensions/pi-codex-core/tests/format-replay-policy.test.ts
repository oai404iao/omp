import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { registerNativeCompaction } from "../src/native-compaction.js";
import { requestOpenAINativeCompaction } from "../src/adapter/compaction/request.js";
import { buildRequestBody } from "../src/providers/openai-codex/request-body.js";
import { closeProviderWebSocketSessions } from "../src/providers/openai-codex/websocket-session.js";
import { resetCodexWireState } from "@oai404iao/pi-codex-runtime/internal/codex-wire-identity";
import { resolveCodexRequestProfile } from "@oai404iao/pi-codex-runtime/internal/codex-request-profile";
import { loadSettings, updateConfig } from "@oai404iao/pi-codex-runtime/internal/settings";
import { resolveModelProfile } from "@oai404iao/pi-codex-runtime/internal/model-catalog/catalog";
import { responsesModel, withCodexSettings } from "../../../tests/codex/support/provider-lifecycle-test-support.js";
import { createProviderHarness } from "./support/openai-codex-test-support.js";
import { startWebSocketServer } from "./support/websocket-test-support.js";
import { buildSessionContext, SessionManager } from "@earendil-works/pi-coding-agent";

afterEach(() => { closeProviderWebSocketSessions(); resetCodexWireState(); });

for (const lite of [false, true]) for (const extensions of [false, true]) {
	for (const capability of ["format", "transport"] as const) test(`denied ${capability}: lite=${lite}, enhancements=${extensions}`, () =>
		withCodexSettings({ codexRequestExtensions: extensions, endpoint_config: [{
			provider: "openai", baseUrl: "https://denied.invalid/v1",
			...(capability === "format" ? { responsesMode: lite ? ["standard"] : ["lite"] } : { transport: ["sse"] }),
		}] }, async cwd => {
			const harness = createProviderHarness({ cwd });
			let requests = 0;
			const result = await harness.providers.openai.streamSimple({
				...responsesModel, id: lite ? "gpt-5.6-sol" : "gpt-5.5", baseUrl: "https://denied.invalid/v1",
			}, { messages: [], tools: [] }, {
				apiKey: "sk-fixture", transport: capability === "format" ? "sse" : "websocket",
				fetch: async () => { requests++; throw new Error("Unexpected dispatch"); },
			}).result();
			assert.equal(result.stopReason, "error");
			assert.match(result.errorMessage, /disabled for this endpoint/);
			assert.equal(requests, 0);
		}));
}

for (const extensions of [false, true]) for (const version of [1, 2, 3, 4]) {
	test(`generation-off preserves checkpoint v${version} replay (enhancements=${extensions})`, () =>
		withCodexSettings({ codexRequestExtensions: !extensions }, async cwd => {
			const originalProfileHash = resolveModelProfile(responsesModel)!.profileHash;
			const handlers: Record<string, Function> = {};
			registerNativeCompaction({ on(name: string, handler: Function) { handlers[name] = handler; } } as any);
			const branch = [{
				type: "compaction", id: "checkpoint", parentId: null, timestamp: new Date(1).toISOString(),
				summary: "placeholder [native-checkpoint:checkpoint]", firstKeptEntryId: version === 4 ? "checkpoint" : null, tokensBefore: 1,
				details: { kind: "openai-native-compaction", version, mode: "responses", checkpointId: "checkpoint",
					provider: responsesModel.provider, api: responsesModel.api, model: responsesModel.id,
					profileHash: `${originalProfileHash}${extensions ? ":wire-off" : ""}`,
					output: [{ type: "compaction", encrypted_content: "KEEP_OPAQUE" }] },
			}];
			const before = structuredClone(branch);
			updateConfig({ compactionMode: "pi", codexRequestExtensions: extensions });
			const ctx = {
				cwd, model: responsesModel, sessionManager: { getSessionId: () => "replay-only", getBranch: () => branch },
				abort() { assert.fail("Replay must not abort merely because generation/enhancements are off"); },
				ui: { notify(message: string, level: string) { if (level === "error") assert.fail(message); } },
			};
			const replay = handlers.context({ messages: buildSessionContext(branch as any).messages }, ctx);
			assert.match(JSON.stringify(replay), /KEEP_OPAQUE/);
			assert.deepEqual(await handlers.session_before_compact({ branchEntries: branch }, ctx), { cancel: true });
			assert.deepEqual(branch, before);
		}));
}

for (const transport of ["sse", "websocket"] as const) for (const lite of [false, true]) for (const extensions of [false, true]) {
	test(`native compaction ${transport}: lite=${lite}, enhancements=${extensions}`, () =>
		withCodexSettings({
			codexRequestExtensions: extensions, compactionMode: "responses", openaiTransport: transport,
			requestProfile: { responsesMode: lite ? "lite" : "standard" },
		}, async () => {
			const output = { type: "compaction", encrypted_content: "COMPACTED_OPAQUE" };
			const events = [{ type: "response.completed", response: { id: "compact-fixture", status: "completed", output: [output] } }];
			const server = transport === "websocket" ? await startWebSocketServer([() => events]) : undefined;
			const previousFetch = globalThis.fetch;
			const assertEnvelope = (body: any) => {
				assert.equal(body.tools === undefined, lite);
				assert.equal(body.reasoning?.context, lite ? "all_turns" : undefined);
				assert.equal(body.parallel_tool_calls, !lite);
				assert.equal(body.input.at(-1).type, "compaction_trigger");
				assert.equal(Boolean(body.client_metadata?.turn_id), extensions);
			};
			globalThis.fetch = async (_url, init) => {
				assertEnvelope(JSON.parse(String(init?.body)));
				const headers = new Headers(init?.headers);
				assert.equal(headers.get("authorization"), "Bearer sk-fixture");
				assert.equal(headers.get("x-openai-internal-codex-responses-lite"), lite ? "true" : null);
				assert.equal(headers.get("x-codex-beta-features"), "remote_compaction_v2");
				return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
			};
			try {
				const checkpoint = await requestOpenAINativeCompaction({
					...responsesModel, baseUrl: server?.url ?? "https://fixture.invalid/v1",
				}, { messages: [], tools: [] }, {
					mode: "responses", apiKey: "sk-fixture", sessionId: "compact-format", settings: loadSettings(),
				});
				assert.match(JSON.stringify(checkpoint), /COMPACTED_OPAQUE/);
				if (server) {
					assert.equal(server.requests.length, 1);
					assertEnvelope(server.requests[0]);
					assert.equal(server.requests[0].client_metadata?.ws_request_header_x_openai_internal_codex_responses_lite, lite ? "true" : undefined);
				}
			} finally {
				globalThis.fetch = previousFetch;
				closeProviderWebSocketSessions();
				await server?.close();
			}
		}));
}

test("Lite mandatory serialization cannot enable parallel calls or convert foreign patch tools", () => {
	const model = { ...responsesModel, id: "gpt-5.6-sol" };
	const body = buildRequestBody(model, {
		messages: [], tools: [{ name: "apply_patch", description: "Foreign patch", parameters: { type: "object" } }],
	}, { ...resolveCodexRequestProfile({ responsesMode: "lite" }), supportsParallelTools: true }, {
		codexRequestExtensions: false, toolProtocols: new Map(),
	});
	assert.equal(body.parallel_tool_calls, false);
	assert.equal((body.input[0] as any).tools[0].tools[0].type, "function");
});

for (const extensions of [false, true]) test(`new checkpoint replays after generation/enhancement switch (generated enhancements=${extensions})`, () =>
	withCodexSettings({ codexRequestExtensions: extensions, webSocketEnabled: false }, async cwd => {
		const manager = SessionManager.inMemory(cwd);
		manager.appendMessage({ role: "user", content: "compact history", timestamp: 1 });
		const handlers: Record<string, Function> = {};
		registerNativeCompaction({
			on(name: string, handler: Function) { handlers[name] = handler; },
			getActiveTools: () => [], getAllTools: () => [], getThinkingLevel: () => "low",
		} as any);
		const ctx = {
			cwd, model: responsesModel, sessionManager: manager, getSystemPrompt: () => "RULE",
			modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "sk-fixture" }) },
			abort() { assert.fail("A checkpoint must survive generation/enhancement switches"); },
			ui: { notify(message: string) { assert.fail(message); } },
		};
		const previousFetch = globalThis.fetch;
		globalThis.fetch = async () => new Response(`data: ${JSON.stringify({
			type: "response.completed", response: {
				id: "generated", status: "completed", output: [{ type: "compaction", encrypted_content: "GENERATED_OPAQUE" }],
			},
		})}\n\n`);
		try {
			const generated = await handlers.session_before_compact({
				branchEntries: manager.getBranch(), preparation: { tokensBefore: 10 }, signal: new AbortController().signal,
			}, ctx);
			assert(generated?.compaction);
			assert.doesNotMatch(generated.compaction.details.profileHash, /wire-off/);
			manager.appendCompaction(generated.compaction.summary, null, 10, generated.compaction.details, true);
			const before = structuredClone(manager.getBranch());
			updateConfig({ compactionMode: "pi", codexRequestExtensions: !extensions });
			const replay = handlers.context({ messages: manager.buildSessionContext().messages }, ctx);
			assert.match(JSON.stringify(replay), /GENERATED_OPAQUE/);
			assert.deepEqual(manager.getBranch(), before);
		} finally { globalThis.fetch = previousFetch; }
	}));
