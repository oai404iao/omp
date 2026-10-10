import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	AgentSession, convertToLlm, createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	createAssistantMessageEventStream, getCurrentTools, InMemoryCredentialStore, type AssistantMessage,
} from "@earendil-works/pi-ai";
import core from "@oai404iao/pi-codex-core";
import web from "@oai404iao/pi-codex-web-search";
import {
	createCompositionHost, withCompositionDirectory, writeCompositionConfig,
} from "./support/composition-host.js";

for (const source of ["sdk", "builtin", "foreign"]) for (const bound of [false, true]) {
	test(`a ${source} patch replacement cannot suppress native tools, previously bound=${bound}`, () =>
		withCompositionDirectory(async (directory) => {
			const host = createCompositionHost(directory);
			const pi = host.api();
			try {
				core(pi);
				if (bound) await host.emit("session_start");
				const original = host.tools.get("apply_patch");
				host.tools.set("apply_patch", { ...original,
					...(source === "foreign" && !bound ? { parameters: { ...original.parameters } } : {}),
					sourceInfo: { path: `<${source}:apply_patch>`, source, scope: "temporary", origin: "top-level" } });
				for (const active of [false, true]) {
					pi.setActiveTools(["read", "edit", "write", ...(active ? ["apply_patch"] : [])]);
					await host.emit(bound ? "session_tree" : "session_start");
					assert.equal(host.active().includes("apply_patch"), active);
					assert(host.active().includes("edit"));
					assert(host.active().includes("write"));
				}
			} finally { host.dispose(); }
		}));
}

test("a replacement web_search cannot be disabled by Codex settings", () =>
	withCompositionDirectory(async (directory) => {
		const host = createCompositionHost(directory);
		try {
			core(host.api());
			web(host.api());
			const original = host.tools.get("web_search");
			host.tools.set("web_search", { ...original, parameters: { ...original.parameters },
				sourceInfo: { path: "<sdk:web_search>", source: "sdk", scope: "temporary", origin: "top-level" } });
			host.ctx.model = { provider: "anthropic", id: "unrelated", input: ["text"] };
			host.api().setActiveTools(["read", "web_search"]);
			await host.emit("session_start");
			assert(host.active().includes("web_search"));
		} finally { host.dispose(); }
	}));

test("replacing an active Codex patch does not change native tool selection", () =>
	withCompositionDirectory(async (directory) => {
		const host = createCompositionHost(directory);
		try {
			core(host.api());
			await host.emit("session_start");
			assert(host.active().includes("apply_patch"));
		assert(host.active().includes("edit"));
		assert(host.active().includes("write"));
			const original = host.tools.get("apply_patch");
			host.tools.set("apply_patch", { ...original,
				sourceInfo: { path: "<foreign:apply_patch>", source: "foreign", scope: "temporary", origin: "top-level" } });
			await host.emit("model_select");
			assert(host.active().includes("apply_patch"));
			assert(host.active().includes("edit"));
			assert(host.active().includes("write"));
		} finally { host.dispose(); }
	}));

test("real Pi loader registers direct patch/search before action methods are bound", () =>
	withCompositionDirectory(async (cwd) => {
		const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
		const loader = new DefaultResourceLoader({
			cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noThemes: true,
			noPromptTemplates: true, noContextFiles: true, extensionFactories: [core, web],
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const modelRuntime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(), modelsPath: null,
			modelsStorePath: join(cwd, "models-store.json"), allowModelNetwork: false,
		});
		modelRuntime.registerProvider("fixture", {
			api: "openai-responses", apiKey: "fixture", baseUrl: "https://fixture.invalid",
			models: [{ id: "offline", name: "offline", reasoning: false, input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 2000 }],
		});
		const { session } = await createAgentSession({
			cwd, agentDir: cwd, modelRuntime, model: modelRuntime.getModel("fixture", "offline"),
			resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), settingsManager,
		});
		try {
			await session.bindExtensions({ mode: "print" });
			assert(session.getToolDefinition("apply_patch"));
			assert(session.getToolDefinition("web_search"));
		} finally {
			await session.abort();
			session.dispose();
			loader.getExtensions().runtime.invalidate();
		}
	}));

test("Codex patch/search remain direct tools with no private Code Mode bus", () =>
	withCompositionDirectory(async (directory) => {
		const host = createCompositionHost(directory);
		try {
			core(host.api());
			web(host.api());
			assert(host.tools.has("apply_patch"));
			assert(host.tools.has("web_search"));
			assert.equal(host.bus.eventNames().filter(name => String(name).startsWith("@oai404iao/pi-code-mode:")).length, 0);
		} finally { host.dispose(); }
	}));

test("Codex shutdown does not rewrite native tool selection", () =>
	withCompositionDirectory(async (directory) => {
		const host = createCompositionHost(directory);
		const pi = host.api();
		try {
			core(pi);
			web(host.api());
			await host.emit("session_start");
			const selected = host.active();
			pi.setActiveTools = () => { throw new Error("shutdown must not change tools"); };
			await host.emit("session_shutdown");
			assert.deepEqual(host.active(), selected);
		} finally { host.dispose(); }
	}));

for (const native of [["edit", "write"], ["edit"], []]) {
	test(`real Pi preserves native selection ${JSON.stringify(native)} through patch projection, tree, reload and resume`, () =>
		withCompositionDirectory(async cwd => {
			writeCompositionConfig(cwd, { webSocketEnabled: false, imageGeneration: false });
			const settingsManager = SettingsManager.inMemory({
				retry: { enabled: false }, compaction: { enabled: false },
			});
			const modelRuntime = await ModelRuntime.create({
				credentials: new InMemoryCredentialStore(), modelsPath: null,
				modelsStorePath: join(cwd, "models-store.json"), allowModelNetwork: false,
			});
			for (const [provider, id] of [["openai", "gpt-6-astra"], ["anthropic", "claude-opus-5-5"]] as const) {
				modelRuntime.registerProvider(provider, {
					api: provider === "openai" ? "openai-responses" : "anthropic-messages",
					apiKey: "fixture", baseUrl: "https://fixture.invalid/v1",
					models: [{ id, name: id, reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1000,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
				});
			}
			const patchModel = modelRuntime.getModel("openai", "gpt-6-astra")!;
			const claudeModel = modelRuntime.getModel("anthropic", "claude-opus-5-5")!;
			let manager = SessionManager.inMemory(cwd);
			const open = async (restore = false) => {
				const loader = new DefaultResourceLoader({
					cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true,
					noThemes: true, noPromptTemplates: true, noContextFiles: true, extensionFactories: [core],
				});
				await loader.reload();
				assert.deepEqual(loader.getExtensions().errors, []);
				const options = {
					cwd, agentDir: cwd, modelRuntime, model: patchModel, resourceLoader: loader,
					sessionManager: manager, settingsManager,
				};
				// The floor SDK factory always supplies an initial selection. Exercise
				// AgentSession's transcript restoration with no selection override.
				const session = restore ? new AgentSession({
					...options,
					agent: new Agent({
						convertToLlm,
						streamFn: () => { throw new Error("fixture prompt must install its capture stream"); },
						initialState: { model: patchModel, thinkingLevel: "off", messages: manager.buildSessionContext().messages },
					}),
				}) : (await createAgentSession({
					...options, tools: ["read", "bash", ...native, "apply_patch"],
				})).session;
				await session.bindExtensions({ mode: "print" });
				return { session, loader };
			};
			let opened = await open();
			const close = async () => {
				await opened.session.abort();
				opened.session.dispose();
				opened.loader.getExtensions().runtime.invalidate();
			};
			const prompt = async (patch: boolean) => {
				const { session } = opened;
				let declared: string[] = [];
				session.agent.streamFunction = (model, context) => {
					declared = getCurrentTools(context.messages).map(tool => tool.name);
					const stream = createAssistantMessageEventStream();
					const message: AssistantMessage = {
						role: "assistant", api: model.api, provider: model.provider, model: model.id,
						content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: Date.now(),
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					};
					queueMicrotask(() => {
						stream.push({ type: "start", partial: message });
						stream.push({ type: "done", reason: "stop", message });
						stream.end();
					});
					return stream;
				};
				await session.prompt("Check the selected tools.");
				assert.equal(declared.includes("apply_patch"), patch);
				for (const name of ["edit", "write"]) {
					const selected = native.includes(name);
					assert.equal(session.getActiveToolNames().includes(name), selected, name);
					assert.equal(session.getCallableToolNames().includes(name), selected, name);
					assert.equal(getCurrentTools(session.messages).some(tool => tool.name === name), selected, name);
					assert.equal(declared.includes(name), selected && !patch, name);
				}
			};
			try {
				await prompt(true);
				const initial = manager.getBranch().find(entry => entry.type === "message" && entry.message.role === "system")!;
				await opened.session.setModel(claudeModel);
				await prompt(false);
				await opened.session.navigateTree(initial.id, { summarize: false });
				await opened.session.setModel(claudeModel);
				await prompt(false);
				await opened.session.setModel(patchModel);
				await prompt(true);
				await opened.session.reload();
				await prompt(true);
				manager = SessionManager.inMemory(cwd, {}, [manager.getHeader()!, ...manager.getEntries()]);
				await close();
				opened = await open(true);
				await opened.session.setModel(claudeModel);
				await prompt(false);
			} finally { await close(); }
		}));
}
