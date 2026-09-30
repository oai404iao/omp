import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
	createAssistantMessageEventStream, getCurrentTools, InMemoryCredentialStore,
	type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
	createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime,
	SessionManager, SettingsManager, type AgentSession,
} from "@earendil-works/pi-coding-agent";
import core from "@oai404iao/pi-codex-core";
import web from "@oai404iao/pi-codex-web-search";
import imagegen from "@oai404iao/pi-codex-imagegen";
import {
	compositionModel, createCompositionHost, withCompositionDirectory, writeCompositionConfig,
} from "./support/composition-host.js";

async function runCode(session: AgentSession, code: string) {
	let requests = 0;
	let declared: string[] = [];
	session.agent.streamFunction = (model, context) => {
		const stream = createAssistantMessageEventStream();
		const first = requests++ === 0;
		if (first) declared = getCurrentTools(context.messages).map(tool => tool.name);
		const message: AssistantMessage = {
			role: "assistant", api: model.api, provider: model.provider, model: model.id,
			content: first
				? [{ type: "toolCall", id: "codemode-call", name: "codemode", arguments: { code } }]
				: [{ type: "text", text: "done" }],
			stopReason: first ? "toolUse" : "stop", timestamp: Date.now(),
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		queueMicrotask(() => {
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });
			stream.end();
		});
		return stream;
	};
	await session.prompt("Inspect the available tools without calling external services.");
	const result = [...session.messages].reverse().find(message => message.role === "toolResult" && message.toolName === "codemode");
	assert(result?.role === "toolResult", JSON.stringify(session.messages));
	assert.equal(result.isError, false, JSON.stringify(result));
	return { declared, text: result.content.filter(block => block.type === "text").map(block => block.text).join("\n") };
}

for (const mode of ["on", "only"] as const) for (const autoEnable of [true, false]) {
	test(`native codemode ${mode} follows model exposure without overriding autoEnable=${autoEnable}`, () =>
		withCompositionDirectory(async cwd => {
			writeCompositionConfig(cwd, { webSocketEnabled: false, autoEnable });
			const settingsManager = SettingsManager.inMemory({
				defaultTools: ["+codemode"], retry: { enabled: false }, compaction: { enabled: false },
			});
			const loader = new DefaultResourceLoader({
				cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true,
				noThemes: true, noPromptTemplates: true, noContextFiles: true,
				extensionFactories: [core, web, imagegen, createCodemodeExtension({ mode, models: false })],
			});
			await loader.reload();
			assert.deepEqual(loader.getExtensions().errors, []);
			const modelRuntime = await ModelRuntime.create({
				credentials: new InMemoryCredentialStore(), modelsPath: null,
				modelsStorePath: join(cwd, "model-store.json"), allowModelNetwork: false,
			});
			modelRuntime.registerProvider("openai", {
				api: "openai-responses", apiKey: "fixture", baseUrl: "https://fixture.invalid/v1",
				models: ["gpt-5.6-sol", "gpt-5.5", "gpt-4.1"].map(id => ({
					...compositionModel(id), input: ["text" as const, "image" as const],
				})),
			});
			const { session } = await createAgentSession({
				cwd, agentDir: cwd, modelRuntime, model: modelRuntime.getModel("openai", "gpt-5.6-sol"),
				resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), settingsManager,
				...(!autoEnable ? { tools: ["read", "codemode", "apply_patch", "view_image", "web_search", "image_generation"] } : {}),
			});
			try {
				if (!autoEnable) session.setActiveToolsByName(["read", "codemode"]);
				await session.bindExtensions({ mode: "print" });
				for (const [id, webExposure, imageExposure] of [
					["gpt-5.6-sol", "direct", "direct"],
					["gpt-5.5", "model-only", "direct"],
					["gpt-4.1", "model-only", "model-only"],
					["gpt-5.6-sol", "direct", "direct"],
				] as const) {
					await session.setModel(modelRuntime.getModel("openai", id)!);
					for (const [name, exposure] of [["web_search", webExposure], ["image_generation", imageExposure]] as const) {
						assert.equal(session.getToolDefinition(name)?.exposure, exposure, `${id}/${name}`);
						assert.equal(session.getActiveToolNames().includes(name), autoEnable && (name !== "web_search" || id !== "gpt-4.1"), `${id}/${name}`);
						assert.equal(session.getCallableToolNames().includes(name), autoEnable && exposure === "direct", `${id}/${name}`);
					}
					if (!autoEnable) assert.deepEqual(session.getActiveToolNames(), ["read", "codemode"]);
					assert.equal(session.getToolDefinition("view_image")?.exposure, "model-only");
					assert(!session.getCallableToolNames().includes("view_image"));
					const result = await runCode(session, `return ALL_TOOLS.map(tool => tool.name).sort();`);
					for (const [name, exposure] of [["web_search", webExposure], ["image_generation", imageExposure]] as const) {
						const expectedActive = autoEnable && (name !== "web_search" || id !== "gpt-4.1");
						assert.equal(result.text.includes(`"${name}"`), expectedActive && exposure === "direct", result.text);
						assert.equal(result.declared.includes(name), expectedActive && (mode === "on" || exposure === "model-only"));
						if (expectedActive && exposure === "model-only") {
							const placeholder = await session.getToolDefinition(name)!.execute(
								"hosted-probe", { prompt: "fixture" }, undefined, undefined,
								{ cwd, model: session.model } as never,
							);
							assert.equal(placeholder.isError, true, name);
						}
					}
				}
			} finally {
				await session.abort();
				session.dispose();
				loader.getExtensions().runtime.invalidate();
			}
		}));
}

test("a foreign image_generation replacement is neither re-exposed nor disabled", () =>
	withCompositionDirectory(async cwd => {
		const host = createCompositionHost(cwd);
		try {
			imagegen(host.api());
			const foreign = { ...host.tools.get("image_generation"), exposure: "hidden",
				parameters: {}, sourceInfo: { source: "sdk" } };
			host.tools.set("image_generation", foreign);
			host.api().setActiveTools(["read", "image_generation"]);
			await host.emit("session_start");
			for (const id of ["gpt-4.1", "gpt-5.6-sol"]) {
				host.ctx.model = compositionModel(id);
				await host.emit("model_select");
				assert.equal(host.tools.get("image_generation"), foreign);
				assert(host.active().includes("image_generation"));
			}
		} finally { host.dispose(); }
	}));
