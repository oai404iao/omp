import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { requestPrefix } from "../src/providers/openai-codex/request-prefix.js";
import { buildRequestBody, requestBodyToolOptions } from "../src/providers/openai-codex/request-body.js";
import { buildSSEHeaders } from "../src/providers/openai-codex/headers.js";
import { createStartupPrewarmLifecycle } from "../src/extension/startup-prewarm.js";
import { closeProviderWebSocketSessions } from "../src/providers/openai-codex/websocket-session.js";
import { prewarmWebSocket } from "../src/providers/openai-codex/prewarm.js";
import { compactionMetadata } from "../src/adapter/compaction/metadata.js";
import { requestOpenAINativeCompaction } from "../src/adapter/compaction/request.js";
import { resolveCodexRequestProfile } from "@oai404iao/pi-codex-runtime/internal/codex-request-profile";
import { loadModelSettings } from "@oai404iao/pi-codex-runtime/internal/model-catalog/runtime";
import { eventContext, withCodexSettings } from "../../../tests/codex/support/provider-lifecycle-test-support.js";
import { startWebSocketServer, successEvents } from "./support/websocket-test-support.js";
import { createProviderHarness } from "./support/openai-codex-test-support.js";

test("Codex 5a314017 prefix UUIDv5 matches OID/thread namespace and sorted serde JSON", () => {
	const thread = "019a58e7-e140-7668-8bbb-eb722ca07e03";
	const tools = [{
		type: "namespace", name: "functions", description: "",
		tools: [{ type: "function", name: "read", description: "Read",
			parameters: { type: "object", properties: {} }, strict: false }],
	}];
	// Fixed values independently derived from core/client.rs:908-940 using RFC 9562 UUIDv5.
	const expected = [
		{ type: "additional_tools", id: "at_a2a4959c-5cef-5703-8a5a-9e4253ffee67", role: "developer", tools },
		{ type: "message", id: "msg_0e905ddd-4d36-5105-8855-8d87a8ae2504", role: "developer",
			content: [{ type: "input_text", text: "fixture instructions" }] },
	];
	assert.deepEqual(requestPrefix(thread, "fixture instructions", tools), expected);
	assert.deepEqual(requestPrefix(thread, "fixture instructions", []), [expected[1]]);
	assert.deepEqual(requestPrefix(thread, "", []), []);
	assert.notDeepEqual(requestPrefix(`${thread}-fork`, "fixture instructions", tools), expected);
});

test("prefix hashing sorts integer-like schema keys lexically rather than JavaScript enumeration order", () => {
	const prefix = requestPrefix("01959e38-5000-7000-8000-000000000001", undefined, [{
		type: "function", name: "fixture", parameters: {
			type: "object", properties: { "2": { type: "string" }, "10": { type: "number" } },
		},
	}]);
	assert.equal((prefix[0] as { id: string }).id, "at_be7ee84c-3812-52f4-a5e9-368249ba1c29");
});

test("execution metadata uses the final onPayload model and effort in headers and body", async () => {
	await withCodexSettings({ openaiTransport: "sse" }, async () => {
		const model = getBuiltinModels("openai").find(model => model.id === "gpt-6-astra")!;
		const provider = createProviderHarness().providers.openai;
		let requests = 0;
		const result = await provider.streamSimple(model, { messages: [], tools: [] }, {
			apiKey: "sk-fixture", sessionId: "payload-model-snapshot",
			onPayload: (payload: Record<string, unknown>) => ({
				...payload, model: "routed-fixture", reasoning: { effort: "high" },
			}),
			fetch: async (_url: unknown, init: RequestInit) => {
				requests++;
				const body = JSON.parse(String(init.body));
				const headerMetadata = JSON.parse(new Headers(init.headers).get("x-codex-turn-metadata")!);
				const bodyMetadata = JSON.parse(body.client_metadata["x-codex-turn-metadata"]);
				assert.equal(body.model, "routed-fixture");
				for (const metadata of [headerMetadata, bodyMetadata]) {
					assert.equal(metadata.model, body.model);
					assert.equal(metadata.reasoning_effort, body.reasoning.effort);
				}
				return new Response(`data: ${JSON.stringify({
					type: "response.completed", response: { id: "fixture", status: "completed", output: [] },
				})}\n\n`);
			},
		}).result();
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.equal(requests, 1);
	});
});

test("Standard and Lite use developer prefixes and model-supported defaults without legacy envelopes", async () => {
	await withCodexSettings({}, async () => {
		const model = getBuiltinModels("openai").find(model => model.id === "gpt-6-astra")!;
		const settings = loadModelSettings(model);
		for (const responsesMode of ["standard", "lite"] as const) {
			const profile = resolveCodexRequestProfile({ ...settings.requestProfile, responsesMode });
			const body = buildRequestBody(model, { systemPrompt: "RULE", messages: [], tools: [] }, profile, requestBodyToolOptions(settings));
			assert.equal(body.instructions, undefined);
			assert.deepEqual(body.input, [{ type: "message", role: "developer", content: [{ type: "input_text", text: "RULE" }] }]);
			assert.equal(body.reasoning?.effort, "low");
			assert.equal(body.reasoning?.context, responsesMode === "lite" ? "all_turns" : undefined);
			assert.deepEqual(body.text, { verbosity: "low" });
			assert.deepEqual(body.tools, responsesMode === "standard" ? [] : undefined);
		}
		const unsupported = buildRequestBody({ ...model, id: "unknown-fixture" }, { messages: [] },
			resolveCodexRequestProfile(), { serviceTier: "priority" } as any);
		assert.equal(unsupported.text, undefined);
		assert.equal(unsupported.service_tier, undefined);
		for (const [tier, expected] of [["default", undefined], ["auto", undefined], ["flex", "flex"], ["unsupported", undefined]]) {
			const body = buildRequestBody(model, { messages: [] }, resolveCodexRequestProfile(), { serviceTier: tier } as any);
			assert.equal(body.service_tier, expected);
		}
	});
});

test("SSE omits the retired experimental beta without overwriting explicit headers", () => {
	const profile = resolveCodexRequestProfile();
	assert.equal(buildSSEHeaders(undefined, undefined, undefined, "fixture", undefined, profile).get("openai-beta"), null);
	assert.equal(buildSSEHeaders(undefined, { "openai-beta": "user-feature" }, undefined, "fixture", undefined, profile).get("openai-beta"), "user-feature");
});

test("Lite prewarm accepts tool/instruction prefixes but not conversation history", async () => {
	await withCodexSettings({ openaiTransport: "websocket", requestProfile: { responsesMode: "lite" } }, async () => {
		const model = getBuiltinModels("openai").find(model => model.id === "gpt-5.6-sol")!;
		const server = await startWebSocketServer([() => successEvents("lite-prefix")]);
		const pi = { getActiveTools: () => [], getAllTools: () => [], getThinkingLevel: () => "low" } as unknown as ExtensionAPI;
		const lifecycle = createStartupPrewarmLifecycle(pi);
		const ctx = eventContext({ ...model, baseUrl: server.url }, "lite-alignment");
		ctx.getSystemPrompt = () => "stable instructions";
		try {
			lifecycle.start(ctx);
			await lifecycle.get("lite-alignment", ctx.model!);
			assert.equal(server.requests.length, 1);
			assert.equal(server.requests[0].generate, false);
			assert.equal(server.requests[0].input[0].role, "developer");
			assert.match(server.requests[0].input[0].id, /^msg_/);
			assert.equal(server.requests[0].client_metadata.ws_request_header_x_openai_internal_codex_responses_lite, "true");
			await assert.rejects(prewarmWebSocket({ body: { input: [{ type: "message", role: "user", content: [] }] } } as any),
				/must not include conversation input/);
		} finally {
			lifecycle.reset(); closeProviderWebSocketSessions(); await server.close();
		}
	});
});

test("compaction metadata comes from Pi trigger and captured history rather than invented policies", () => {
	for (const [reason, willRetry, role, phase] of [
		["manual", false, "assistant", "standalone_turn"],
		["threshold", false, "user", "pre_turn"],
		["threshold", false, "toolResult", "mid_turn"],
		["threshold", false, "assistant", "post_turn"],
		["overflow", true, "assistant", "mid_turn"],
	] as const) {
		const event = { reason, willRetry, branchEntries: [{ type: "message", message: { role, stopReason: "stop" } }] } as SessionBeforeCompactEvent;
		assert.deepEqual(compactionMetadata(event), {
			trigger: reason === "manual" ? "manual" : "auto",
			reason: reason === "manual" ? "user_requested" : "context_limit",
			implementation: "responses_compaction_v2", phase, strategy: "memento",
		});
	}
});

test("removed unary compaction fails before any request dispatch", async () => {
	await assert.rejects(requestOpenAINativeCompaction({} as any, {} as any, {
		mode: "responses-compact", signal: new AbortController().signal,
	} as any), /Only Responses compaction_trigger/);
});
