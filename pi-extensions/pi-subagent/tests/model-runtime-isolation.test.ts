import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { InMemoryCredentialStore, InMemoryModelsStore, type Model, type Provider } from "@earendil-works/pi-ai";
import {
	createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { createChildModelRuntime } from "../src/model-runtime.ts";
import { deferred, stream, usage } from "./support/fixture.ts";

const modelDefinition = {
	id: "echo", name: "Echo", reasoning: false, input: ["text"] as ["text"],
	cost: usage.cost, contextWindow: 100000, maxTokens: 1000,
};

async function rootRuntime() {
	const credentials = new InMemoryCredentialStore();
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
	return { runtime, credentials };
}

function register(runtime: ModelRuntime, text: string) {
	runtime.registerProvider("scripted", {
		baseUrl: "http://scripted.invalid", apiKey: "synthetic-key", api: "openai-responses",
		models: [modelDefinition],
		streamSimple: (model, _context, options) => stream(model, text, options?.signal),
	});
}

async function answer(runtime: ModelRuntime, provider = "scripted") {
	const model = runtime.getModel(provider, "echo");
	assert.ok(model);
	const response = await runtime.completeSimple(model, { messages: [] });
	assert.equal(response.stopReason, "stop", response.errorMessage ?? "scripted request failed");
	return response.content.flatMap(part => part.type === "text" ? [part.text] : []).join("");
}

function workspace(t: TestContext) {
	const scratchRoot = join(homedir(), ".local", "state", "agents", "tmp");
	mkdirSync(scratchRoot, { recursive: true });
	const cwd = mkdtempSync(join(scratchRoot, "pi-subagent-model-isolation-test-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	return cwd;
}

async function extensionSession(t: TestContext, runtime: ModelRuntime, name: string, calls: string[],
	routeContexts?: Array<{ owner: string; sessionId: string }>) {
	const cwd = workspace(t);
	let api!: ExtensionAPI;
	const services = await createAgentSessionServices({
		cwd, agentDir: join(cwd, "agent"), modelRuntime: runtime,
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
		resourceLoaderOptions: {
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [{ name: "captured-provider", factory: pi => {
				api = pi;
				pi.events.on("isolation:request", () => { calls.push(name); });
				pi.registerProvider("scripted", {
					baseUrl: "http://scripted.invalid", apiKey: "synthetic-key", api: "openai-responses",
					models: [modelDefinition],
					streamSimple: (model, _context, options) => {
						pi.events.emit("isolation:request", undefined);
						return stream(model, name, options?.signal);
					},
				});
				if (routeContexts) pi.registerVirtualModel({
					provider: "router", id: "auto", name: "Auto", thinkingLevels: ["off"],
					route: (_request, ctx) => {
						routeContexts.push({ owner: name, sessionId: ctx.sessionManager.getSessionId() });
						const selected = ctx.modelRegistry.find("scripted", "echo");
						assert.ok(selected, "virtual route retains a live SDK extension context");
						return { model: selected, thinkingLevel: "off" };
					},
				});
			} }],
		},
	});
	assert.deepEqual(services.diagnostics, []);
	const { session } = await createAgentSessionFromServices({
		services, sessionManager: SessionManager.inMemory(cwd), model: runtime.getModel("scripted", "echo"),
		thinkingLevel: "off", noTools: "all",
	});
	t.after(() => session.dispose());
	await session.bindExtensions({ mode: "print" });
	return { session, api };
}

test("fresh SDK extension callbacks stay local before and after child disposal", async t => {
	const { runtime: root } = await rootRuntime();
	const calls: string[] = [];
	const parent = await extensionSession(t, root, "root", calls);
	const rootCallback = root.getRegisteredProviderConfig("scripted")?.streamSimple;
	const childRuntime = createChildModelRuntime(root);
	assert.notEqual(childRuntime, root);
	const child = await extensionSession(t, childRuntime, "child", calls);
	await parent.session.prompt("root before child");
	await child.session.prompt("child request");
	assert.equal(parent.session.getLastAssistantText(), "root");
	assert.equal(child.session.getLastAssistantText(), "child");
	child.session.dispose();
	await parent.session.prompt("root after child disposal");
	assert.equal(parent.session.getLastAssistantText(), "root");
	assert.equal(root.getRegisteredProviderConfig("scripted")?.streamSimple, rootCallback);
	assert.deepEqual(calls, ["root", "child", "root"]);
});

test("interleaved siblings and extension unregister cannot replace root or peer callbacks", async t => {
	const { runtime: root } = await rootRuntime();
	const calls: string[] = [];
	await extensionSession(t, root, "root", calls);
	const first = createChildModelRuntime(root);
	const second = createChildModelRuntime(root);
	const firstSession = await extensionSession(t, first, "first", calls);
	await extensionSession(t, second, "second", calls);
	const started = deferred();
	const finish = deferred<string>();
	first.registerProvider("scripted", {
		api: "openai-responses",
		streamSimple: (model, _context, options) => {
			started.resolve();
			return stream(model, finish.promise, options?.signal);
		},
	});
	const pending = answer(first);
	await started.promise;
	assert.equal(await answer(second), "second");
	assert.equal(await answer(root), "root");
	finish.resolve("first delayed");
	assert.equal(await pending, "first delayed");
	firstSession.api.unregisterProvider("scripted");
	assert.equal(first.getModel("scripted", "echo"), undefined);
	assert.equal(await answer(second), "second");
	assert.equal(await answer(root), "root");
	assert.deepEqual(calls, ["second", "root", "second", "root"]);
});

test("root legacy/native providers, runtime credentials and virtual routes survive isolated mutations", async () => {
	const { runtime: root, credentials } = await rootRuntime();
	register(root, "legacy root");
	const nativeModel: Model<any> = { ...root.getModel("scripted", "echo")!, provider: "native" };
	const native: Provider = {
		id: "native", name: "Native", getModels: () => [nativeModel],
		auth: { apiKey: { name: "Synthetic", resolve: async ({ credential }) => credential?.key
			? { auth: { apiKey: credential.key }, source: "fixture" } : undefined } },
		stream: (model, _context, options) => stream(model, "native root", options?.signal),
		streamSimple: (model, _context, options) => stream(model, "native root", options?.signal),
	};
	root.registerNativeProvider(native);
	await credentials.modify("native", async () => ({ type: "api_key", key: "stored-synthetic" }));
	await root.setRuntimeApiKey("native", "root-synthetic");
	root.registerVirtualModel({ provider: "router", id: "auto", name: "Auto", thinkingLevels: ["off"],
		route: () => ({ model: nativeModel, thinkingLevel: "off" }) });
	const child = createChildModelRuntime(root);
	await child.refresh({ allowNetwork: false });
	assert.equal(await answer(child), "legacy root");
	assert.equal(await answer(child, "native"), "native root");
	assert.equal((await child.getAuth("native"))?.auth.apiKey, "root-synthetic");
	assert.ok((await child.getAvailable("router")).some(model => model.id === "auto"));
	const selected = child.getModel("router", "auto")!;
	const route = await child.resolveModel(selected, [], { reason: "direct", thinkingLevel: "off" });
	assert.equal(route.model.provider, "native");
	await child.setRuntimeApiKey("native", "child-synthetic");
	assert.equal((await root.getAuth("native"))?.auth.apiKey, "root-synthetic");
	await child.removeRuntimeApiKey("native");
	assert.equal((await child.getAuth("native"))?.auth.apiKey, "stored-synthetic");
	await credentials.modify("native", async () => ({ type: "api_key", key: "updated-stored-synthetic" }));
	assert.equal((await child.getAuth("native"))?.auth.apiKey, "updated-stored-synthetic");
	assert.equal((await root.getAuth("native"))?.auth.apiKey, "root-synthetic");
	child.unregisterVirtualModel("router", "auto");
	child.unregisterProvider("native");
	assert.ok(root.getModel("router", "auto"));
	assert.equal(await answer(root, "native"), "native root");
});

test("grandchildren use the canonical root baseline rather than disposed child overrides", async t => {
	const { runtime: root } = await rootRuntime();
	register(root, "root baseline");
	const child = createChildModelRuntime(root);
	const calls: string[] = [];
	const loaded = await extensionSession(t, child, "transient child", calls);
	assert.equal(await answer(child), "transient child");
	child.registerVirtualModel({ provider: "child-only", id: "auto", name: "Child only",
		route: () => ({ model: child.getModel("scripted", "echo")!, thinkingLevel: "off" }) });
	loaded.session.dispose();
	const grandchild = createChildModelRuntime(child);
	assert.equal(await answer(grandchild), "root baseline");
	assert.equal(grandchild.getModel("child-only", "auto"), undefined);
	register(grandchild, "grandchild local");
	assert.equal(await answer(grandchild), "grandchild local");
	assert.equal(await answer(root), "root baseline");
	assert.deepEqual(calls, ["transient child"]);
});

test("resolved dynamic legacy catalogs survive child refresh without invoking root refresh callbacks", async () => {
	const { runtime: root } = await rootRuntime();
	const refreshCalls: boolean[] = [];
	root.registerProvider("scripted", {
		baseUrl: "http://scripted.invalid", apiKey: "synthetic-key", api: "openai-responses",
		models: [modelDefinition],
		refreshModels: async context => {
			refreshCalls.push(context.allowNetwork);
			return [{ ...modelDefinition, id: context.allowNetwork ? "refreshed" : "echo" }];
		},
		streamSimple: (model, _context, options) => stream(model, "dynamic root", options?.signal),
	});
	// Only this synthetic provider refreshes; allowNetwork changes the fixture catalog without doing I/O.
	await root.refresh({ allowNetwork: false, providers: ["scripted"] });
	await root.refresh({ allowNetwork: true, providers: ["scripted"] });
	assert.deepEqual(root.getModels("scripted").map(model => model.id), ["refreshed"]);
	const before = [...refreshCalls];
	assert.ok(before.includes(true));
	const child = createChildModelRuntime(root);
	assert.deepEqual(child.getModels("scripted").map(model => model.id), ["refreshed"]);
	const result = await child.refresh({ allowNetwork: false });
	assert.equal(result.errors.size, 0);
	assert.deepEqual(child.getModels("scripted").map(model => model.id), ["refreshed"]);
	assert.deepEqual(refreshCalls, before, "child never executes the root's catalog refresh closure");
	const selected = child.getModel("scripted", "refreshed")!;
	const response = await child.completeSimple(selected, { messages: [] });
	assert.equal(response.stopReason, "stop");
	assert.deepEqual(response.content, [{ type: "text", text: "dynamic root" }]);
});

test("SDK virtual routes retain live root context and inherited extensions recreate child-local routes", async t => {
	const { runtime: root } = await rootRuntime();
	const calls: string[] = [];
	const routes: Array<{ owner: string; sessionId: string }> = [];
	const parent = await extensionSession(t, root, "root", calls, routes);
	const resolve = async (runtime: ModelRuntime) => {
		const selected = runtime.getModel("router", "auto");
		assert.ok(selected);
		const routed = await runtime.resolveModel(selected, [], { reason: "direct", thinkingLevel: "off" });
		assert.equal(routed.model.provider, "scripted");
		assert.equal(routed.model.id, "echo");
	};
	await resolve(root);
	const child = createChildModelRuntime(root);
	await child.refresh({ allowNetwork: false });
	await resolve(child);
	const loaded = await extensionSession(t, child, "child", calls, routes);
	await resolve(child);
	loaded.api.unregisterVirtualModel("router", "auto");
	loaded.session.dispose();
	await resolve(root);
	const grandchild = createChildModelRuntime(child);
	await grandchild.refresh({ allowNetwork: false });
	await resolve(grandchild);
	assert.deepEqual(routes, [
		{ owner: "root", sessionId: parent.session.sessionId },
		{ owner: "root", sessionId: parent.session.sessionId },
		{ owner: "child", sessionId: loaded.session.sessionId },
		{ owner: "root", sessionId: parent.session.sessionId },
		{ owner: "root", sessionId: parent.session.sessionId },
	]);
});

test("native provider prototype methods retain their receiver in a child snapshot", async () => {
	const { runtime: root } = await rootRuntime();
	register(root, "root");
	const model = { ...root.getModel("scripted", "echo")!, provider: "native" };
	const auth = root.getProvider("scripted")!.auth;
	class NativeProvider {
		#text = "prototype native";
		get id() { return "native"; }
		get name() { return "Native prototype"; }
		get auth() { return auth; }
		getModels() { return [model]; }
		stream(selected: Model<any>) { return stream(selected, this.#text); }
		streamSimple(selected: Model<any>) { return stream(selected, this.#text); }
	}
	root.registerNativeProvider(new NativeProvider());
	const child = createChildModelRuntime(root);
	await child.refresh({ allowNetwork: false });
	assert.equal(await answer(child, "native"), "prototype native");
	assert.equal(await answer(root, "native"), "prototype native");
});

test("an unrelated unavailable native catalog cannot block healthy child models", async () => {
	const { runtime: root } = await rootRuntime();
	register(root, "healthy");
	const base = root.getProvider("scripted")!;
	root.registerNativeProvider({
		...base, id: "optional", name: "Unavailable optional provider",
		getModels: () => { throw new Error("catalog unavailable"); },
		getAllModels: () => [{
			type: "image", id: "image", name: "Optional image", provider: "optional", api: "fixture-images",
			baseUrl: "http://fixture.invalid", input: ["text"], output: ["image"], cost: usage.cost,
		}],
	});
	const child = createChildModelRuntime(root);
	await child.refresh({ allowNetwork: false });
	assert.equal(await answer(child), "healthy");
	assert.deepEqual(child.getModels("optional"), []);
	assert.equal(child.getModelOfType("image", "optional", "image")?.id, "image");
});

test("child cache-only refresh preserves root remote catalog wrapper state", async () => {
	const credentials = new InMemoryCredentialStore();
	const modelsStore = new InMemoryModelsStore();
	await credentials.modify("openai", async () => ({ type: "api_key", key: "synthetic-openai" }));
	const root = await ModelRuntime.create({ credentials, modelsStore, modelsPath: null, allowModelNetwork: false });
	const builtin = root.getModels("openai")[0]!;
	assert.ok(builtin);
	const cached = { ...builtin, id: "synthetic-cached-root-model" };
	await modelsStore.write("openai", { models: [cached], lastModified: Date.UTC(2100, 0, 1) });
	await root.refresh({ allowNetwork: false, providers: ["openai"] });
	assert.ok(root.getModel("openai", cached.id));
	const rootProvider = root.getProvider("openai")!;
	const before = rootProvider.getModels().map(model => model.id);
	const child = createChildModelRuntime(root);
	assert.ok(child.getModel("openai", cached.id));
	const refreshed = await child.refresh({ allowNetwork: false });
	assert.equal(refreshed.aborted, false);
	assert.equal(refreshed.errors.size, 0);
	assert.deepEqual(rootProvider.getModels().map(model => model.id), before);
	assert.ok(root.getModel("openai", cached.id));
	assert.ok(child.getModel("openai", cached.id));
	const childCatalog = child.getAllModels("openai").map(model => model.id);
	await modelsStore.write("openai", {
		models: [{ ...cached, id: "synthetic-newer-root-model" }], lastModified: Date.UTC(2100, 0, 2),
	});
	await root.refresh({ allowNetwork: false, providers: ["openai"] });
	assert.ok(root.getModel("openai", "synthetic-newer-root-model"));
	assert.deepEqual(child.getAllModels("openai").map(model => model.id), childCatalog);
});
