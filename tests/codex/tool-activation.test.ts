import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import {
	createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import core from "@oai404iao/pi-codex-core";
import web from "@oai404iao/pi-codex-web-search";
import { createCompositionHost, withCompositionDirectory } from "./support/composition-host.js";

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

test("replacing an active Codex patch restores previously suppressed native tools", () =>
	withCompositionDirectory(async (directory) => {
		const host = createCompositionHost(directory);
		try {
			core(host.api());
			await host.emit("session_start");
			assert(host.active().includes("apply_patch"));
			assert(!host.active().includes("edit"));
			assert(!host.active().includes("write"));
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

test("Codex shutdown restores native tools and retries a failed restoration", () =>
	withCompositionDirectory(async (directory) => {
		const host = createCompositionHost(directory);
		const pi = host.api();
		let restorationFails = false;
		const write = pi.setActiveTools;
		pi.setActiveTools = (names) => {
			if (restorationFails && names.includes("edit")) {
				restorationFails = false;
				throw new Error("native restore failed");
			}
			write(names);
		};
		try {
			core(pi);
			web(host.api());
			await host.emit("session_start");
			assert(!host.active().includes("edit"));
			restorationFails = true;
			await assert.rejects(host.emit("session_shutdown"), (error: AggregateError) => {
				assert.equal(error.errors.length, 1);
				assert.match((error.errors[0] as Error).message, /native restore failed/);
				return true;
			});
			await host.emit("session_shutdown");
			assert(host.active().includes("edit"));
			assert(host.active().includes("write"));
		} finally { host.dispose(); }
	}));
