import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import test from "node:test";
import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import core from "@oai404iao/pi-codex-core";
import tools from "@oai404iao/pi-codex-tools";
import { buildRequestBody } from "@oai404iao/pi-codex-core/internal/providers/openai-codex/request-body";
import { activeToolSnapshot } from "@oai404iao/pi-codex-core/internal/extension/tool-snapshot";
import { resolveCodexRequestProfile } from "@oai404iao/pi-codex-runtime/internal/codex-request-profile";
import web from "@oai404iao/pi-codex-web-search";
import image from "@oai404iao/pi-codex-imagegen";
import { getOpenAICodexLatestImagePath } from "@oai404iao/pi-codex-tools/internal/tools/image-generation/storage";
import { CODEX_BROKER_CHANNEL, CODEX_RUNTIME_VERSION, getCodexBroker } from "@oai404iao/pi-codex-runtime";
import { createCodexSubagentInlineExtension } from "@oai404iao/pi-codex-runtime/subagent-inline";
import bundle from "@oai404iao/pi-codex-minimal-tools";
import { snapshotOwnedToolProtocols } from "@oai404iao/pi-codex-runtime/internal/tool-activation";
import {
	compositionModel, createCompositionHost, withCompositionDirectory, writeCompositionConfig,
} from "./support/composition-host.js";
import { createAssistantMessage, deferred } from "./support/provider-lifecycle-test-support.js";

const cases = [
	{ name: "bundle", factories: [bundle], tools: ["apply_patch", "image_generation", "web_search"], core: true },
	{ name: "core", factories: [core], tools: [], core: true },
	{ name: "tools", factories: [tools], tools: ["apply_patch", "image_generation", "web_search"], core: false },
	{ name: "core+tools", factories: [core, tools], tools: ["apply_patch", "image_generation", "web_search"], core: true },
	{ name: "web", factories: [web], tools: ["web_search"], core: false },
	{ name: "image", factories: [image], tools: ["image_generation"], core: false },
	{ name: "core+web", factories: [core, web], tools: ["web_search"], core: true },
	{ name: "core+image", factories: [core, image], tools: ["image_generation"], core: true },
	{ name: "web+image", factories: [web, image], tools: ["image_generation", "web_search"], core: false },
	{ name: "compatibility entries", factories: [core, web, image], tools: ["image_generation", "web_search"], core: true },
	{ name: "bundle+capabilities", factories: [bundle, core, tools, web, image, bundle], tools: ["apply_patch", "image_generation", "web_search"], core: true },
];

for (const scenario of cases) {
	for (const reverse of scenario.factories.length > 1 ? [false, true] : [false]) {
		test(`${scenario.name}: ${reverse ? "reversed" : "forward"} separate API roots compose once`, () =>
			withCompositionDirectory(async directory => {
				const host = createCompositionHost(directory);
				try {
					for (const install of reverse ? [...scenario.factories].reverse() : scenario.factories) install(host.api());
					assert.deepEqual([...host.tools.keys()].sort(), scenario.tools);
					assert.equal(host.providers.size, scenario.core ? 2 : 0);
					await host.emit("session_start");
					for (const name of scenario.tools) {
						assert.equal(host.active().includes(name), name !== "apply_patch" || scenario.core,
							`${name} requires its declared execution capability`);
					}
					assert.ok(host.active().includes("unrelated"));
					assert(host.active().includes("edit"));
					assert(host.active().includes("write"));
					host.ctx.model = compositionModel("unknown-future-model");
					await host.emit("model_select");
					assert.deepEqual(host.active(), ["read", "edit", "write", "bash", "unrelated"]);
					await host.emit("session_shutdown");
					assert.equal(host.bus.eventNames().length, 0);
				} finally { host.dispose(); }
			}));
	}
}

for (const applyPatch of [false, true]) for (const webSearch of [false, true]) for (const imageGeneration of [false, true]) {
	test(`tools-only gates are independent: ${JSON.stringify({ applyPatch, webSearch, imageGeneration })}`, () =>
		withCompositionDirectory(async directory => {
			writeCompositionConfig(directory, { applyPatch, webSearch, imageGeneration });
			const host = createCompositionHost(directory);
			try {
				tools(host.api()); web(host.api()); image(host.api()); tools(host.api());
				const expected = [
					...(applyPatch ? ["apply_patch"] : []),
					...(imageGeneration ? ["image_generation"] : []),
					...(webSearch ? ["web_search"] : []),
				];
				assert.deepEqual([...host.tools.keys()].sort(), expected);
				assert.equal(host.providers.size, 0);
				assert.equal(host.commands.has("image-gen"), imageGeneration);
				assert.equal(host.renderers.has("codex-image-generation-display"), imageGeneration);
				assert.equal(host.renderers.has("codex-web-search-activity"), webSearch);
				const broker = getCodexBroker(host.api());
				assert.deepEqual([...broker.ownedTools.keys()].sort(), expected);
				await host.emit("session_start");
				assert.equal(host.active().includes("apply_patch"), false, "custom patch needs an actual engine");
				assert.equal(host.active().includes("web_search"), webSearch);
				assert.equal(host.active().includes("image_generation"), imageGeneration);
			} finally { await host.emit("session_shutdown"); host.dispose(); }
		}));
}

test("custom patch needs an engine supporting the actual model, not a core installation flag", () =>
	withCompositionDirectory(async directory => {
		const host = createCompositionHost(directory);
		try {
			tools(host.api());
			const broker = getCodexBroker(host.api());
			broker.coreEnabled = true;
			await host.emit("session_start");
			assert(!host.active().includes("apply_patch"));
			const input = { input: "*** Begin Patch\n*** Add File: forbidden.txt\n+no\n*** End Patch" };
			const noEngine = await host.tools.get("apply_patch").execute("patch", input, undefined, undefined, host.ctx);
			assert.equal(noEngine.isError, true);
			assert.match(noEngine.content[0].text, /requires pi-codex-core with a compatible Responses engine/);
			assert.equal(existsSync(`${directory}/forbidden.txt`), false);
			core(host.api());
			host.ctx.model.api = "anthropic-messages";
			await host.emit("model_select");
			assert(!host.active().includes("apply_patch"));
			assert.equal(broker.engine!.supports(host.ctx.model), false);
			const incompatible = await host.tools.get("apply_patch").execute("patch", input, undefined, undefined, host.ctx);
			assert.equal(incompatible.isError, true);
			assert.match(incompatible.content[0].text, /requires pi-codex-core with a compatible Responses engine/);
			host.ctx.model = compositionModel();
			await host.emit("model_select");
			assert(host.active().includes("apply_patch"));
		} finally { await host.emit("session_shutdown"); host.dispose(); }
	}));

test("tools-only explicitly configured function patch executes without a Responses provider", () =>
	withCompositionDirectory(async directory => {
		writeCompositionConfig(directory, { additionalModelIds: ["custom/fixture"] });
		const host = createCompositionHost(directory);
		try {
			tools(host.api());
			host.ctx.model = compositionModel("fixture", "custom");
			await host.emit("session_start");
			assert(host.active().includes("apply_patch"));
			assert.equal(host.providers.size, 0);
			const result = await host.tools.get("apply_patch").execute("patch", {
				input: "*** Begin Patch\n*** Add File: independent.txt\n+fixture\n*** End Patch",
			}, undefined, undefined, host.ctx);
			assert.equal(result.isError, false);
			assert.equal(result.details.success, true);
			assert.equal(result.structuredContent.files[0].path, "independent.txt");
			assert(existsSync(`${directory}/independent.txt`));
		} finally { await host.emit("session_shutdown"); host.dispose(); }
	}));

test("tools-only standalone search and images execute without registering Responses", t =>
	withCompositionDirectory(async directory => {
		const host = createCompositionHost(directory);
		host.ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "fixture-only" });
		const requests: string[] = [];
		t.mock.method(globalThis, "fetch", async (url: unknown) => {
			requests.push(String(url));
			if (String(url).endsWith("/alpha/search")) return Response.json({ output: "fixture", results: [] });
			if (String(url).endsWith("/images/generations")) return Response.json({ data: [{ b64_json: "AQ==" }] });
			throw new Error(`Unexpected request: ${url}`);
		});
		try {
			tools(host.api());
			await host.emit("session_start");
			const search = await host.tools.get("web_search").execute("search",
				{ search_query: [{ q: "fixture" }] }, undefined, undefined, host.ctx);
			assert.equal(search.isError, false);
			assert.equal(search.details.success, true);
			const generated = await host.tools.get("image_generation").execute("image",
				{ prompt: "fixture" }, undefined, undefined, host.ctx);
			assert(generated.structuredContent.path);
			assert.equal(generated.isError, false);
			assert.equal(generated.details.success, true);
			assert.match(generated.content.find((block: { type: string }) => block.type === "text").text, /Do not repeat it as a Markdown image/);
			assert.equal(host.providers.size, 0);
			assert.equal(requests.length, 2);
			assert(requests.every(url => !url.endsWith("/responses")));
		} finally { await host.emit("session_shutdown"); host.dispose(); }
	}));

test("owned patch descriptors snapshot only the registered implementation and matching request tools", () =>
	withCompositionDirectory(async directory => {
		const host = createCompositionHost(directory);
		try {
			core(host.api()); tools(host.api());
			const api = host.api();
			const broker = getCodexBroker(api);
			const patch = host.tools.get("apply_patch");
			const getAllTools = api.getAllTools;
			api.getAllTools = () => [
				...getAllTools(),
				...["read", "edit", "write", "bash"].map(name => ({ name, description: name, parameters: {} })),
			] as ReturnType<typeof getAllTools>;
			api.setActiveTools(["read", "edit", "write", "bash", "apply_patch"]);
			assert.deepEqual(activeToolSnapshot(api).map(tool => tool.name), ["apply_patch", "bash"]);
			api.setActiveTools(["read", "edit", "write", "bash"]);
			assert.deepEqual(activeToolSnapshot(api).map(tool => tool.name), ["read", "edit", "write", "bash"]);
			const snapshot = snapshotOwnedToolProtocols(api, broker, [patch]);
			assert.equal(snapshot.get("apply_patch")?.customTool.type, "custom");
			assert.deepEqual(snapshot.get("apply_patch")?.hiddenTools, ["read", "edit", "write"]);
			assert.equal(snapshotOwnedToolProtocols(api, broker, [{ ...patch, parameters: {} }]).size, 0);
			host.tools.set("apply_patch", { ...patch, parameters: { ...patch.parameters },
				sourceInfo: { source: "sdk", path: "<sdk:apply_patch>" } });
			assert.equal(snapshotOwnedToolProtocols(api, broker, [patch]).size, 0);
			const body = buildRequestBody(host.ctx.model, { messages: [], tools: [patch] },
				resolveCodexRequestProfile({ patchTransport: "custom" }), {
					toolProtocols: snapshotOwnedToolProtocols(api, broker, [patch]),
				});
			assert.equal((body.tools as any[])[0].type, "function", "a foreign same-name tool must never become custom");
			assert.equal(snapshot.get("apply_patch")?.customTool.type, "custom", "earlier snapshots retain their descriptor");
		} finally { await host.emit("session_shutdown"); host.dispose(); }
	}));

test("Responses patch declarations and replay carry wire descriptions and result text, not Pi metadata", () =>
	withCompositionDirectory(async directory => {
		const host = createCompositionHost(directory);
		const model: Model<"openai-responses"> = host.ctx.model;
		try {
			const api = host.api();
			core(api); tools(api);
			await host.emit("session_start");
			const patch = host.tools.get("apply_patch");
			const toolProtocols = snapshotOwnedToolProtocols(api, getCodexBroker(api), [patch]);
			const description = "The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.";
			const inputs = ["*** Begin Patch\n*** Add File: replay.txt\n+hello\n*** End Patch", "invalid patch"];
			const messages: Context["messages"] = [];
			const expectedOutputs = [];
			for (const [index, input] of inputs.entries()) {
				const id = `call_patch_${index}`;
				const result = await patch.execute(id, { input }, undefined, undefined, host.ctx);
				assert.equal(result.details.success, index === 0);
				assert.equal(result.isError, index === 1);
				const assistant = createAssistantMessage(model);
				assistant.stopReason = "toolUse";
				assistant.content = [{ type: "toolCall", name: "apply_patch", id, arguments: { input } }];
				messages.push(assistant, { ...result, role: "toolResult" as const,
					toolCallId: id, toolName: "apply_patch", timestamp: Date.now() });
				expectedOutputs.push({ type: "custom_tool_call_output", call_id: id, output: result.content[0].text });
			}
			for (const responsesMode of ["standard", "lite"] as const) {
				const body = buildRequestBody(model, { messages, tools: [patch] },
					resolveCodexRequestProfile({ patchTransport: "custom", responsesMode }), { toolProtocols });
				const declarations = responsesMode === "standard" ? body.tools as any[]
					: (body.input.find(item => (item as { type?: string }).type === "additional_tools") as any).tools[0].tools;
				assert.equal(declarations[0].description, description);
				assert.deepEqual(body.input.filter(item => (item as { type?: string }).type === "custom_tool_call_output"), expectedOutputs);
			}
		} finally { await host.emit("session_shutdown"); host.dispose(); }
	}));

test("hosted-only capabilities are inactive without core and manual invocation fails explicitly", () =>
	withCompositionDirectory(async directory => {
		const host = createCompositionHost(directory);
		try {
			web(host.api()); image(host.api());
			host.ctx.model = compositionModel("gpt-5.5", "openai-codex");
			await host.emit("session_start");
			assert.equal(host.active().includes("web_search"), false);
			assert.equal(host.active().includes("image_generation"), true); // Standalone in this profile.
			const failure = await host.tools.get("web_search").execute("w", { search_query: [{ q: "test" }] }, undefined, undefined, host.ctx);
			assert.equal(failure.isError, true);
			assert.match(failure.content[0].text, /requires pi-codex-core/);
			host.ctx.model = compositionModel("gpt-4.1");
			await host.emit("model_select");
			assert(host.active().includes("image_generation"), "standalone image generation does not require core");
			await host.emit("session_shutdown");
		} finally { host.dispose(); }
	}));

test("capability disablement and legacy autoEnable config survive independent loading", () =>
	withCompositionDirectory(async directory => {
		writeCompositionConfig(directory, { autoEnable: false, enabled: true });
		const host = createCompositionHost(directory);
		try {
			tools(host.api()); core(host.api()); web(host.api()); image(host.api());
			await host.emit("session_start");
			assert.deepEqual(host.active(), ["read", "edit", "write", "bash", "unrelated"]);
			await host.emit("session_shutdown");
		} finally { host.dispose(); }
	}));

test("disabled initial configuration registers no tools or providers across duplicate roots", () =>
	withCompositionDirectory(async directory => {
		writeCompositionConfig(directory, { enabled: false });
		const host = createCompositionHost(directory);
		try {
			bundle(host.api()); tools(host.api()); web(host.api()); image(host.api());
			await host.emit("session_start");
			assert.equal(host.tools.size, 0);
			assert.equal(host.providers.size, 0);
			assert.equal(host.renderers.size, 0);
			await host.emit("session_shutdown");
		} finally { host.dispose(); }
	}));

test("global image gate registers no image capability while preserving core and web behavior", () =>
	withCompositionDirectory(async directory => {
		writeCompositionConfig(directory, { imageGeneration: false });
		const host = createCompositionHost(directory);
		try {
			image(host.api()); tools(host.api()); core(host.api()); web(host.api());
			assert.equal(host.tools.has("image_generation"), false);
			assert.equal(host.commands.has("image-gen"), false);
			assert.equal(getCodexBroker(host.api()).tools.has("image_generation"), false);
			assert.equal(host.providers.size, 2);
			host.ctx.model = compositionModel("gpt-6-astra", "openai-codex");
			await host.emit("session_start");
			assert.equal(host.active().includes("image_generation"), false);
			assert.equal(host.active().includes("apply_patch"), true);
			assert.equal(host.active().includes("web_search"), true);
			await host.emit("session_shutdown");
		} finally { host.dispose(); }
	}));

test("new/fork clear presentation ownership; shutdown and reload create a fresh broker", () =>
	withCompositionDirectory(async directory => {
		const host = createCompositionHost(directory);
		const firstApi = host.api();
		bundle(firstApi);
		const broker = getCodexBroker(firstApi);
		let clears = 0;
		let flushes = 0;
		broker.addPresentation("fixture", {
			clear() { clears++; }, flush() { flushes++; }, scheduleFlush() {}, registerRenderers() {},
			streamEffects: () => ({}),
		});
		try {
			for (const reason of ["start", "new", "fork"]) {
				host.ctx.sessionManager = SessionManager.inMemory(directory);
				await host.emit("session_start", { reason });
			}
			assert.equal(clears, 3);
			await host.emit("session_shutdown");
			assert.equal(clears, 4);
			assert.equal(flushes, 1);
			assert.equal(broker.closed, true);
			assert.equal(host.bus.eventNames().length, 0);
		} finally { host.dispose(); }
		const replacement = createCompositionHost(directory, host.bus);
		try {
			const api = replacement.api();
			web(api); image(replacement.api()); tools(replacement.api()); core(replacement.api());
			assert.notEqual(getCodexBroker(api), broker);
			await replacement.emit("session_start");
			assert.equal(replacement.tools.size, 3);
			await replacement.emit("session_shutdown");
		} finally { replacement.dispose(); }
	}));

test("broker protocol mismatch fails before any registration", () =>
	withCompositionDirectory(async directory => {
		const host = createCompositionHost(directory);
		host.bus.on(CODEX_BROKER_CHANNEL, request => request.accept({ version: 1 }));
		try {
			assert.throws(() => web(host.api()), /Incompatible/);
			assert.equal(host.tools.size, 0);
			assert.equal(host.providers.size, 0);
		} finally { host.dispose(); }
	}));

test("two distinct live brokers cannot both answer discovery", () =>
	withCompositionDirectory(async directory => {
		const host = createCompositionHost(directory);
		const broker = getCodexBroker(host.api());
		host.bus.on(CODEX_BROKER_CHANNEL, request => request.accept({ ...broker }));
		try {
			assert.throws(() => image(host.api()), /duplicate Codex capability broker/);
			assert.equal(host.tools.size, 0);
		} finally { host.dispose(); }
	}));

for (const [label, override] of Object.entries({
	"different major": { runtimeVersion: "0.0.0" },
	"different prerelease": { runtimeVersion: `${CODEX_RUNTIME_VERSION}-fixture.1` },
	"old strict ABI": { version: 2 },
	"missing tool registry": { tools: undefined },
	"partial tool registry": { tools: { get() {}, set() {} } },
	"invalid installed engine": { engine: {} },
	"missing peer compatibility": { acceptsRuntime: undefined },
	"peer refuses this runtime": { acceptsRuntime: () => false },
	"peer cannot complete handshake": { acceptsRuntime() { throw new Error("handshake failed"); } },
})) {
	test(`incompatible broker (${label}) fails discovery and cached access before installation`, () =>
		withCompositionDirectory(async directory => {
			const owner = createCompositionHost(directory);
			const candidate = { ...getCodexBroker(owner.api()), ...override };
			try {
				for (const cached of [false, true]) {
					const host = createCompositionHost(directory);
					const api = host.api();
					if (cached) Object.defineProperty(api, Symbol.for("@oai404iao/pi-codex/broker/v1"), { value: candidate });
					else host.bus.on(CODEX_BROKER_CHANNEL, request => request.accept(candidate));
					try {
						assert.throws(() => image(api), /Incompatible or duplicate Codex/);
						const parent = SessionManager.inMemory(directory);
						const inline = createCodexSubagentInlineExtension({ parentSessionManager: parent });
						const factory = typeof inline === "function" ? inline : inline.factory;
						assert.throws(() => factory(api), /Incompatible or duplicate Codex/);
						assert.equal(parent.getEntries().length, 0);
						assert.equal(host.handlers.size, 0);
						assert.equal(host.tools.size, 0);
						assert.equal(host.providers.size, 0);
					} finally { host.dispose(); }
				}
			} finally { owner.dispose(); }
		}));
}

const imageEvent = {
	type: "response.output_item.done",
	item: { type: "image_generation_call", id: "late-image", result: "AQ==", output_format: "png" },
};

for (const capability of [undefined, web, image]) {
	test(`core rewrites only installed capability placeholders (${capability?.name ?? "none"})`, () =>
		withCompositionDirectory(async directory => {
			const host = createCompositionHost(directory);
			try {
				core(host.api());
				capability?.(host.api());
				host.ctx.model = compositionModel("gpt-5.5", "openai-codex");
				const handler = host.handlers.get("before_provider_request")![0]!;
				const tools = ["web_search", "image_generation"].map(name => ({
					type: "function", name, parameters: { type: "object" },
				}));
				const payload = { tools };
				const result = await handler({ payload }, host.ctx);
				if (!capability) assert.equal(result, undefined);
				const actual = result?.tools ?? tools;
				for (let index = 0; index < tools.length; index++) {
					if (host.tools.has(tools[index]!.name)) {
						assert.notEqual(actual[index].type, "function");
					} else {
						assert.equal(actual[index], tools[index], "uninstalled names belong to other extensions");
					}
				}
				assert.ok(payload.tools.every(tool => tool.type === "function"));
				const context = {
					messages: [],
					tools: tools.map(tool => ({ ...tool, description: "fixture" })),
				};
				let captured: any;
				const stream = host.providers.get("openai-codex").streamSimple(host.ctx.model, context, {
					apiKey: "fixture-only",
					headers: { "chatgpt-account-id": "fixture-account" },
					onPayload(body: unknown) {
						captured = body;
						throw new Error("fixture stopped before I/O");
					},
				});
				assert.match((await stream.result()).errorMessage, /fixture stopped before I\/O/);
				for (let index = 0; index < tools.length; index++) {
					assert.equal(captured.tools[index].type === "function", !host.tools.has(tools[index]!.name));
				}
				const lite = buildRequestBody(host.ctx.model, context, resolveCodexRequestProfile({ responsesMode: "lite" }), {
					ownsNativeTool: name => host.tools.has(name),
				});
				const namespaces = (lite.input[0] as any).tools;
				const functions = namespaces.find((ns: any) => ns.name === "functions")?.tools ?? [];
				assert.deepEqual(functions.map((tool: any) => tool.name), tools.filter(tool => !host.tools.has(tool.name)).map(tool => tool.name));
			} finally {
				await host.emit("session_shutdown");
				host.dispose();
			}
		}));
}

for (const replaceSession of [false, true]) {
	test(replaceSession ? "a late Responses image cannot notify a replacement session" : "a Responses image notifies its own session",
		{ timeout: 10_000 }, t => withCompositionDirectory(async directory => {
			writeCompositionConfig(directory, { openaiTransport: "sse", openaiWebSocketPrewarm: false });
			const host = createCompositionHost(directory);
			const requestStarted = deferred<void>();
			const releaseResponse = deferred<void>();
			let pending: Promise<AssistantMessage> | undefined;
			try {
				const api = host.api();
				image(api); core(host.api());
				await host.emit("session_start");
				const result: Promise<AssistantMessage> = host.providers.get("openai").streamSimple(host.ctx.model, {
					messages: [{ role: "user", content: "fixture", timestamp: 0 }], tools: [],
				}, {
					apiKey: "fixture-only", transport: "sse", maxRetries: 0, signal: t.signal,
					sessionId: host.ctx.sessionManager.getSessionId(),
					fetch: async (url: string) => {
						assert.equal(url, `${host.ctx.model.baseUrl}/responses`);
						requestStarted.resolve();
						await releaseResponse.promise;
						const events = [
							{ type: "response.created", response: { id: "resp_image" } },
							{ ...imageEvent, output_index: 0 },
							{ type: "response.completed", response: { id: "resp_image", status: "completed", output: [imageEvent.item] } },
						];
						return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
							headers: { "content-type": "text/event-stream" },
						});
					},
				}).result();
				pending = result;
				await Promise.race([requestStarted.promise, result.then(output => {
					assert.fail(`expected the SSE request to start: ${output.errorMessage ?? output.stopReason}`);
				})]);
				if (replaceSession) {
					host.ctx.sessionManager = SessionManager.inMemory(directory);
					await host.emit("session_start", { reason: "fork" });
				}
				releaseResponse.resolve();
				const output = await result;
				assert.equal(output.stopReason, "stop", output.errorMessage ?? "fixture response did not finish");
				const path = getOpenAICodexLatestImagePath(directory);
				assert.ok(path);
				assert.deepEqual(readFileSync(path), Buffer.from(imageEvent.item.result, "base64"));
				getCodexBroker(api).presentation.flush();
				if (replaceSession) {
					assert.deepEqual(host.messages, [], "old image display leaked into the replacement session");
				} else {
					assert.equal(host.messages.length, 1);
					assert.equal(host.messages[0].customType, "codex-image-generation-display");
					assert.equal(host.messages[0].details.savedImages[0].callId, imageEvent.item.id);
				}
			} finally {
				releaseResponse.resolve();
				try {
					await pending;
					await host.emit("session_shutdown");
				} finally { host.dispose(); }
			}
		}));
}

test("composed capture keeps old sinks invalid after session replacement and honors abort", () =>
	withCompositionDirectory(async directory => {
		const host = createCompositionHost(directory);
		const api = host.api();
		image(api); core(host.api());
		const broker = getCodexBroker(api);
		try {
			await host.emit("session_start");
			const controller = new AbortController();
			const effects = broker.presentation.streamEffects();
			await host.emit("session_start", { reason: "fork" });
			const observe = effects.createEventObserver!({
				cwd: directory, signal: controller.signal, output: {} as any, stream: {} as any,
			});
			await observe(imageEvent);
			broker.presentation.flush();
			assert.equal(host.messages.length, 0);
			const path = getOpenAICodexLatestImagePath(directory);
			assert.equal(existsSync(path), true); // Clear invalidates UI, not disk writes.
			const files = readdirSync(dirname(path));
			controller.abort();
			await observe({ ...imageEvent, item: { ...imageEvent.item, id: "aborted-image" } });
			assert.deepEqual(readdirSync(dirname(path)), files);
			await host.emit("session_shutdown");
		} finally { host.dispose(); }
	}));

for (const install of [core, web]) {
	test(`${install.name} without imagegen observes old image items without saving files`, () =>
		withCompositionDirectory(async directory => {
			const host = createCompositionHost(directory);
			const api = host.api();
			install(api);
			try {
				const broker = getCodexBroker(api);
				await broker.presentation.streamEffects().createEventObserver!({
					cwd: directory, output: {} as any, stream: {} as any,
				})(imageEvent);
				assert.equal(existsSync(getOpenAICodexLatestImagePath(directory)), false);
				assert.equal(host.messages.length, 0);
				await host.emit("session_shutdown");
			} finally { host.dispose(); }
		}));
}
