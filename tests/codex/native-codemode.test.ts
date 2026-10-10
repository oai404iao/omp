import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	createAssistantMessageEventStream, getCurrentTools, InMemoryCredentialStore,
	type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
	createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime,
	SessionManager, SettingsManager, withFileMutationQueue, type AgentSession, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import core from "@oai404iao/pi-codex-core";
import web from "@oai404iao/pi-codex-web-search";
import imagegen from "@oai404iao/pi-codex-imagegen";
import {
	compositionModel, createCompositionHost, withCompositionDirectory, writeCompositionConfig,
} from "./support/composition-host.js";

async function runCode(session: AgentSession, code: string, expectError = false) {
	let requests = 0;
	let declared: string[] = [];
	session.agent.streamFunction = (model, context) => {
		const stream = createAssistantMessageEventStream();
		const first = requests++ === 0;
		if (first) declared = getCurrentTools(context.messages).map(tool => tool.name);
		const message: AssistantMessage = {
			role: "assistant", api: model.api, provider: model.provider, model: model.id,
			content: first
				? [{ type: "toolCall", id: `codemode-${session.messages.length}`, name: "codemode", arguments: { code } }]
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
	assert.equal(result.isError, expectError, JSON.stringify(result));
	return { declared, result, text: result.content.filter(block => block.type === "text").map(block => block.text).join("\n") };
}

async function withNativeCodemode(
	{ mode = "only", autoEnable = true, extensions = [] }: { mode?: "on" | "only"; autoEnable?: boolean; extensions?: ExtensionFactory[] },
	run: (session: AgentSession, cwd: string, runtime: ModelRuntime) => Promise<void>,
) {
	return withCompositionDirectory(async cwd => {
		writeCompositionConfig(cwd, { webSocketEnabled: false, autoEnable });
		const settingsManager = SettingsManager.inMemory({
			defaultTools: ["+codemode"], retry: { enabled: false }, compaction: { enabled: false },
		});
		const loader = new DefaultResourceLoader({
			cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true,
			noThemes: true, noPromptTemplates: true, noContextFiles: true,
			extensionFactories: [core, web, imagegen, createCodemodeExtension({ mode, models: false }), ...extensions],
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
			await run(session, cwd, modelRuntime);
		} finally {
			await session.abort();
			session.dispose();
			loader.getExtensions().runtime.invalidate();
		}
	});
}

for (const mode of ["on", "only"] as const) for (const autoEnable of [true, false]) {
	test(`native codemode ${mode} follows model exposure without overriding autoEnable=${autoEnable}`, () =>
		withNativeCodemode({ mode, autoEnable }, async (session, cwd, modelRuntime) => {
			for (const [id, webExposure, imageExposure] of [
				["gpt-5.6-sol", "direct", "direct"],
				["gpt-5.5", "model-only", "direct"],
				["gpt-4.1", "model-only", "direct"],
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
		}));
}

for (const mode of ["on", "only"] as const) {
	test(`native codemode ${mode} can use selected native editing tools while patch declarations are preferred`, () =>
		withNativeCodemode({ mode }, async (session, cwd) => {
			assert(session.getActiveToolNames().includes("apply_patch"));
			for (const name of ["edit", "write"]) {
				assert(session.getActiveToolNames().includes(name));
				assert(session.getCallableToolNames().includes(name));
			}
			const result = await runCode(session, `
				await tools.write({ path: "native-fallback.txt", content: "fallback" });
				return ALL_TOOLS.map(tool => tool.name);
			`);
			assert.equal(readFileSync(join(cwd, "native-fallback.txt"), "utf8"), "fallback");
			for (const name of ["edit", "write"]) {
				assert(result.text.includes(`"${name}"`));
				assert(!result.declared.includes(name));
			}
			assert(getCurrentTools(session.messages).some(tool => tool.name === "write"));
		}));
}

test("native codemode receives structured patch/search/image data and forwards images explicitly", () =>
	withNativeCodemode({}, async (session, cwd) => {
		const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1sAAAAASUVORK5CYII=";
		const originalFetch = globalThis.fetch;
		const requests: string[] = [];
		globalThis.fetch = async input => {
			const url = String(input);
			requests.push(url);
			if (url.endsWith("/alpha/search")) return Response.json({
				output: "Fixture result [ref1]", results: [{ ref_id: "ref1", title: "Fixture", url: "https://example.test" }],
			});
			if (url.endsWith("/images/generations")) return Response.json({ data: [{ b64_json: png }] });
			throw new Error(`Unexpected network: ${url}`);
		};
		try {
			const patch = "*** Begin Patch\n*** Add File: nested.txt\n+hello\n*** End Patch";
			const { result, text } = await runCode(session, `
				const patch = await tools.apply_patch({ input: ${JSON.stringify(patch)} });
				const search = await tools.web_search({ search_query: [{ q: "fixture" }] });
				const generated = await tools.image_generation({ prompt: "fixture" });
				if (patch.files[0].kind !== "add" || !patch.summary) throw new Error("invalid patch data");
				if (search.results[0].ref_id !== "ref1") throw new Error("invalid search data");
				if (!generated.path || !generated.latestPath) throw new Error("missing image paths");
				image(generated.image);
				return { summary: patch.summary, output: search.output, path: generated.path };
			`);
			assert.equal(readFileSync(join(cwd, "nested.txt"), "utf8"), "hello\n");
			assert.match(text, /Fixture result \[ref1\]/);
			assert(result.content.some(block => block.type === "image" && block.data === png));
			assert.equal(readFileSync(join(cwd, ".pi", "openai-codex-images", "latest.png")).toString("base64"), png);
			assert.equal(requests.length, 2);
			assert.equal(session.messages.filter(message => message.role === "toolResult").length, 1);
			assert.deepEqual(result.nestedCalls?.calls.map(call => call.name), ["apply_patch", "web_search", "image_generation"]);
		} finally { globalThis.fetch = originalFetch; }
	}));

test("nested patch permissions and standalone backend errors remain failures, not structured successes", () =>
	withNativeCodemode({ extensions: [pi => {
		pi.on("tool_call", event => event.toolName === "apply_patch"
			? { block: true, reason: "fixture permission denied" } : undefined);
	}] }, async (session, cwd) => {
		const patch = "*** Begin Patch\n*** Add File: forbidden.txt\n+no\n*** End Patch";
		const denied = await runCode(session, `return await tools.apply_patch({ input: ${JSON.stringify(patch)} });`, true);
		assert.match(denied.text, /fixture permission denied/);
		assert.equal(existsSync(join(cwd, "forbidden.txt")), false);
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => new Response("fixture backend failure", { status: 503 });
		try {
			for (const code of [
				`return await tools.web_search({ search_query: [{ q: "fixture" }] });`,
				`return await tools.image_generation({ prompt: "fixture" });`,
			]) {
				const failure = await runCode(session, code, true);
				assert.match(failure.text, /HTTP 503/);
			}
		} finally { globalThis.fetch = originalFetch; }
	}));

test("aborting a nested patch waiting on the file queue does not mutate the file", { timeout: 10_000 }, () =>
	withNativeCodemode({}, async (session, cwd) => {
		const path = join(cwd, "queued.txt");
		writeFileSync(path, "before\n");
		let release!: () => void;
		let locked!: () => void;
		const acquired = new Promise<void>(resolve => { locked = resolve; });
		const held = withFileMutationQueue(path, async () => {
			locked();
			await new Promise<void>(resolve => { release = resolve; });
		});
		await acquired;
		let nestedStarted!: () => void;
		const started = new Promise<void>(resolve => { nestedStarted = resolve; });
		const unsubscribe = session.subscribe(event => {
			if (event.type === "tool_execution_start" && event.toolName === "apply_patch" && event.parentToolCallId) nestedStarted();
		});
		const patch = "*** Begin Patch\n*** Update File: queued.txt\n@@\n-before\n+after\n*** End Patch";
		try {
			const running = runCode(session, `return await tools.apply_patch({ input: ${JSON.stringify(patch)} });`, true);
			await started;
			const aborted = session.abort();
			release();
			await Promise.all([aborted, running, held]);
			assert.equal(readFileSync(path, "utf8"), "before\n");
		} finally { release(); unsubscribe(); await held; }
	}));

test("tool_result redaction cannot leak the original structured search result to scripts", () =>
	withNativeCodemode({ extensions: [pi => {
		pi.on("tool_result", event => event.toolName === "web_search"
			? { content: [{ type: "text", text: "REDACTED" }] } : undefined);
	}] }, async session => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => Response.json({ output: "SECRET_OUTPUT", results: [{ title: "SECRET_TITLE" }] });
		try {
			const { text } = await runCode(session, `return await tools.web_search({ search_query: [{ q: "fixture" }] });`);
			assert.match(text, /REDACTED/);
			assert.doesNotMatch(text, /SECRET/);
		} finally { globalThis.fetch = originalFetch; }
	}));

for (const replaceContent of [false, true]) {
	test(`Pi tool_result error conversion replaces content=${replaceContent}`, () =>
		withNativeCodemode({ extensions: [pi => {
			pi.on("tool_result", event => event.toolName === "web_search" ? {
				isError: true,
				...(replaceContent ? { content: [{ type: "text" as const, text: "rejected by result policy" }] } : {}),
			} : undefined);
		}] }, async session => {
			const originalFetch = globalThis.fetch;
			globalThis.fetch = async () => Response.json({ output: "original successful search", results: [] });
			try {
				const { result, text } = await runCode(session,
					`return await tools.web_search({ search_query: [{ q: "fixture" }] });`, replaceContent);
				assert.equal(result.nestedCalls?.calls[0]?.status, "error");
				assert.match(text, replaceContent ? /rejected by result policy/ : /original successful search/);
				if (replaceContent) assert.doesNotMatch(text, /original successful search/);
			} finally { globalThis.fetch = originalFetch; }
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
