import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { Type } from "typebox";
import { createEventBus, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { normalizeContext, type ApiStreamSimpleFunction, type Model, type TranscriptContext } from "@earendil-works/pi-ai/compat";
import { registerResponsesProviderRuntime } from "../../pi-codex-core/src/extension/provider-runtime.ts";
import { createInitialAssistantMessage } from "../../pi-codex-core/src/providers/openai-codex/message.ts";
import { withCodexSettings, responsesModel } from "../../pi-codex-minimal-tools/tests/support/provider-lifecycle-test-support.ts";
import { codexJwt } from "../../pi-codex-minimal-tools/tests/support/openai-codex-test-support.ts";
import { EXEC_SAMPLING, projectExecHistory, resolveProtocol, TRANSPORT_DISCOVER_V2, TRANSCRIPT_SEMANTICS, type TransportCapability } from "../src/protocol.ts";
import { grammarResponse, wireTools } from "./grammar-fixtures.ts";

for (const api of ["openai-responses", "openai-codex-responses"] as const) {
	for (const mode of ["enabled", "disabled", "profile-disabled", "shim-disabled"] as const) {
		test(`real Codex transport capability and checkpoint wire: ${api}/${mode}`, async (t) => {
			await withCodexSettings({ enabled: mode !== "disabled", webSocketEnabled: false }, async (cwd) => {
				const model: Model<typeof api> = { ...responsesModel, api,
					provider: api === "openai-responses" ? "openai" : "openai-codex",
					id: api === "openai-responses" ? "gpt-5.5" : "gpt-6-astra",
					baseUrl: "https://transport.invalid/v1",
					compat: { supportsMidConvoSystemMessages: true, supportsOpenAIGrammarTools: true },
				};
				await writeFile(join(cwd, "extensions/pi-codex-minimal-tools/models.json"), JSON.stringify({
					version: 1, models: [{ id: `${model.provider}/${model.id}`, enabled: mode !== "profile-disabled",
						responses: { providerShim: mode !== "shim-disabled", transport: "sse", websocketPrewarm: false } }],
				}));
				const events = createEventBus();
				const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
				const providers = new Map<string, { streamSimple: ApiStreamSimpleFunction }>();
				const pi = { events,
					registerProvider(name: string, config: { streamSimple: ApiStreamSimpleFunction }) { providers.set(name, config); },
					on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
						handlers.set(name, [...(handlers.get(name) ?? []), handler]);
					},
				} as unknown as ExtensionAPI;
				registerResponsesProviderRuntime(pi, { getCurrentCwd: () => cwd });
				const stream = providers.get(model.provider)!.streamSimple;
				const offers: TransportCapability[] = [];
				events.emit(TRANSPORT_DISCOVER_V2, { protocol: 2, accept: (offer: TransportCapability) => offers.push(offer) });
				assert.equal(offers.length, 1);
				assert.equal(offers[0].stream, stream);
				assert.equal(providers.get("openai")!.streamSimple, providers.get("openai-codex")!.streamSimple);
				assert.equal(offers[0].projection, "effective-checkpoint");
				assert.deepEqual(offers[0].semantics, TRANSCRIPT_SEMANTICS);
				const ctx = { cwd, model, sessionManager: { getBranch: () => [], getSessionId: () => "transport-fixture" },
					modelRegistry: { getRegisteredProviderConfig: (name: string) => providers.get(name) },
				} as unknown as ExtensionContext;
				assert.equal(resolveProtocol(pi, ctx, "grammar").grammar, true);
				const requests: Record<string, any>[] = [];
				const original = globalThis.fetch;
				globalThis.fetch = async (input, init) => {
					const request = new Request(input, init);
					assert.equal(new URL(request.url).hostname, "transport.invalid");
					const bytes = Buffer.from(await request.arrayBuffer());
					requests.push(JSON.parse((request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes) : bytes).toString()));
					return grammarResponse(api, undefined, `checkpoint_${requests.length}`);
				};
				t.after(() => { globalThis.fetch = original; });
				try {
					for (const grammar of [false, true]) {
						const exec = { name: "exec", description: "exec", parameters: Type.Object({ code: Type.String() }),
							constrainedSampling: grammar ? EXEC_SAMPLING : false as const };
						const old = { name: "lookup", description: "OBSOLETE_TOOL", parameters: Type.Object({ old: Type.String() }) };
						const args = { code: "text('历史')", yield_time_ms: 0, timeout_ms: 1000, max_tokens: 99 };
						const raw = "// @exec: {\"yield_time_ms\":0}\r\ntext('原始');\r\n";
						const messages: TranscriptContext["messages"] = [
							{ role: "system", content: "BASE", sections: { rules: "OBSOLETE_RULE", deleted: "DELETED_RULE" },
								toolsAdded: [exec, old, { ...old, name: "removed" }], timestamp: 1 },
							{ role: "user", content: "QUESTION", timestamp: 2 },
							{ ...createInitialAssistantMessage(model), content: [
								{ type: "toolCall", id: "exec_one", name: "exec", arguments: args },
								{ type: "toolCall", id: "exec_raw", name: "exec", arguments: { code: raw } },
							] },
							{ role: "toolResult", toolCallId: "exec_one", toolName: "exec", isError: false,
								content: [{ type: "text", text: "RESULT_ONE" }], details: { cellId: "kept-cell" }, timestamp: 3 },
							{ role: "toolResult", toolCallId: "exec_raw", toolName: "exec", isError: false,
								content: [{ type: "text", text: "RESULT_RAW" }], timestamp: 4 },
							{ role: "system", content: "", sections: { rules: "CURRENT_RULE", deleted: null },
								toolsRemoved: [{ name: "removed" }], toolsAdded: [{
									...old, description: "CURRENT_TOOL", parameters: Type.Object({ current: Type.Number() }),
								}], timestamp: 5 },
						];
						const before = structuredClone(messages);
						const result = await stream(model, normalizeContext({ messages: grammar ? projectExecHistory(messages) as TranscriptContext["messages"] : messages }),
							{ apiKey: codexJwt(), transport: "sse", maxRetries: 0 }).result();
						assert.notEqual(result.stopReason, "error", result.errorMessage ?? "");
						assert.deepEqual(messages, before);
						const body = requests.at(-1)!;
						const wire = JSON.stringify(body);
						assert.match(wire, /CURRENT_RULE/);
						assert.doesNotMatch(wire, /OBSOLETE_RULE|DELETED_RULE|OBSOLETE_TOOL/);
						assert.match(wire, /QUESTION/);
						assert.deepEqual(wireTools(body).map((tool) => tool.name).sort(), ["exec", "lookup"]);
						const lookup = wireTools(body).find((tool) => tool.name === "lookup")!;
						assert.equal(lookup.description, "CURRENT_TOOL");
						assert.deepEqual(lookup.parameters, { type: "object", properties: { current: { type: "number" } }, required: ["current"] });
						const calls = body.input.filter((item: any) => item.type === (grammar ? "custom_tool_call" : "function_call"));
						assert.equal(calls.length, 2);
						if (grammar) {
							assert.equal(calls[0].input, `// @exec: {"yield_time_ms":0,"timeout_ms":1000,"max_tokens":99}\n${args.code}`);
							assert.equal(calls[1].input, raw);
						} else {
							assert.deepEqual(JSON.parse(calls[0].arguments), args);
							assert.equal(JSON.parse(calls[1].arguments).code, raw);
						}
						const results = body.input.filter((item: any) => item.type === (grammar ? "custom_tool_call_output" : "function_call_output"));
						assert.equal(results.length, 2);
						assert.match(JSON.stringify(results), /RESULT_ONE/);
						assert.match(JSON.stringify(results), /RESULT_RAW/);
					}
				} finally {
					globalThis.fetch = original;
					for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
				}
				events.emit(TRANSPORT_DISCOVER_V2, { protocol: 2, accept: (offer: TransportCapability) => offers.push(offer) });
				assert.equal(offers.length, 1, "shutdown removes the actual transport handshake");
			});
		});
	}
}
