import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { SubagentCoordinator, type AgentCaller } from "../../pi-extensions/pi-subagent/src/coordinator.js";
import { DEFAULT_SETTINGS } from "../../pi-extensions/pi-subagent/src/config.js";
import { withCompositionDirectory, writeCompositionConfig } from "./support/composition-host.js";
import { deferred } from "./support/provider-lifecycle-test-support.js";

function successfulResponse(text: string) {
	const item = { type: "message", id: `msg_${text}`, role: "assistant", status: "completed",
		content: [{ type: "output_text", text, annotations: [] }] };
	const events = [
		{ type: "response.created", response: { id: `resp_${text}` } },
		{ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.completed", response: {
			id: `resp_${text}`, status: "completed", output: [item],
			usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
		} },
	];
	return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

async function until(predicate: () => boolean) {
	const deadline = Date.now() + 10000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, "coordinator did not reach the expected state");
		await new Promise(done => setTimeout(done, 5));
	}
}

test("real inherited core/tools leave the parent provider live after siblings, cold resume and failed startup", t =>
	withCompositionDirectory(async cwd => {
		writeCompositionConfig(cwd, { webSocketEnabled: false });
		writeFileSync(join(cwd, "settings.json"), JSON.stringify({
			retry: { enabled: false }, compaction: { enabled: false },
		}));
		const extensions = join(cwd, "extensions", "inherited-codex");
		mkdirSync(extensions, { recursive: true });
		const packageRoot = resolve(import.meta.dirname, "../../pi-extensions/pi-subagent");
		const coreEntry = resolve(import.meta.dirname, "../../pi-extensions/pi-codex-core/index.ts");
		const toolsEntry = resolve(import.meta.dirname, "../../pi-extensions/pi-codex-tools/index.ts");
		const failFile = join(cwd, "fail-inherited-startup");
		writeFileSync(join(extensions, "index.ts"), `
			import { existsSync } from "node:fs";
			import core from ${JSON.stringify(coreEntry)};
			import tools from ${JSON.stringify(toolsEntry)};
			export default pi => {
				core(pi);
				tools(pi);
				if (existsSync(${JSON.stringify(failFile)})) throw new Error("inherited startup failure");
			};
		`);
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("openai", async () => ({ type: "api_key", key: "synthetic-fixture-key" }));
		const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
		modelRuntime.registerProvider("openai", { baseUrl: "https://fixture.invalid/v1" });
		const model = modelRuntime.getModel("openai", "gpt-5.6-sol");
		assert.ok(model);
		let coordinator!: SubagentCoordinator;
		let caller!: AgentCaller;
		const captureRoot: ExtensionFactory = pi => {
			coordinator = new SubagentCoordinator(pi, packageRoot, { ...DEFAULT_SETTINGS, inheritExtensions: true }, cwd);
			pi.on("session_start", (_event, ctx) => { caller = coordinator.attachRoot(ctx); });
		};
		const services = await createAgentSessionServices({
			cwd, agentDir: cwd, modelRuntime,
			resourceLoaderOptions: { noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
				extensionFactories: [captureRoot] },
		});
		assert.deepEqual(services.diagnostics, []);
		const { session: parent } = await createAgentSessionFromServices({
			services, sessionManager: SessionManager.create(cwd, join(cwd, "sessions")), model, thinkingLevel: "off",
		});
		const requests: Record<string, unknown>[] = [];
		let siblingGate: ReturnType<typeof deferred<void>> | undefined;
		t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
			assert.equal(new URL(String(url)).hostname, "fixture.invalid", "unexpected network destination");
			assert.ok(new URL(String(url)).pathname.endsWith("/responses"));
			requests.push(JSON.parse(String(init?.body)));
			const text = `fixture-answer-${requests.length}`;
			await siblingGate?.promise;
			return successfulResponse(text);
		});
		try {
			await parent.bindExtensions({ mode: "print" });
			const callback = modelRuntime.getRegisteredProviderConfig("openai")?.streamSimple;
			assert.equal(typeof callback, "function", "real core registered its provider shim");
			for (const name of ["apply_patch", "web_search", "image_generation"]) {
				assert.ok(parent.getToolDefinition(name), `real tools registered ${name}`);
			}
			await parent.prompt("root before delegation");
			assert.equal(parent.getLastAssistantText(), "fixture-answer-1");
			siblingGate = deferred<void>();
			await coordinator.spawn(caller, { task_name: "first", message: "first child", fork_turns: "none" });
			await coordinator.spawn(caller, { task_name: "second", message: "second child", fork_turns: "none" });
			await until(() => requests.length === 3);
			assert.equal(coordinator.activeCount, 2);
			assert.equal(modelRuntime.getRegisteredProviderConfig("openai")?.streamSimple, callback);
			siblingGate.resolve();
			siblingGate = undefined;
			await until(() => coordinator.activeCount === 0);
			for (const name of ["first", "second"]) {
				assert.equal(coordinator.treeStore.record(`/root/${name}`).status, "completed");
			}
			assert.equal(modelRuntime.getRegisteredProviderConfig("openai")?.streamSimple, callback);
			await parent.prompt("root after both child runtimes disposed");
			assert.equal(parent.getLastAssistantText(), "fixture-answer-4");
			const childFile = coordinator.treeStore.record("/root/first").sessionFile;
			await coordinator.followup(caller, "first", "cold resume");
			await until(() => coordinator.activeCount === 0);
			assert.equal(coordinator.treeStore.record("/root/first").status, "completed");
			assert.equal(coordinator.treeStore.record("/root/first").sessionFile, childFile);
			await parent.prompt("root after cold child runtime disposed");
			assert.equal(parent.getLastAssistantText(), "fixture-answer-6");
			writeFileSync(failFile, "fixture");
			await assert.rejects(coordinator.spawn(caller, {
				task_name: "broken", message: "must fail during inherited factory startup", fork_turns: "none",
			}), /inherited startup failure/);
			await until(() => coordinator.activeCount === 0);
			assert.equal(modelRuntime.getRegisteredProviderConfig("openai")?.streamSimple, callback);
			await parent.prompt("root after failed child startup");
			assert.equal(parent.getLastAssistantText(), "fixture-answer-7");
			assert.equal(requests.length, 7, "failed startup never streamed a child request");
			for (const request of requests) {
				assert.equal(request.model, "gpt-5.6-sol");
				const declaration = (request.input as Array<{
					type?: string; tools?: Array<{ tools?: Array<{ type?: string; name?: string }> }>;
				}>).find(item => item.type === "additional_tools");
				assert.ok(declaration, "real core used the configured Lite wire format");
				assert.ok(declaration.tools?.flatMap(namespace => namespace.tools ?? [])
					.some(tool => tool.type === "custom" && tool.name === "apply_patch"),
				"real tools supplied the broker-owned custom patch protocol to each runtime");
			}
		} finally {
			siblingGate?.resolve();
			await coordinator.shutdown();
			await parent.abort();
			parent.dispose();
			services.resourceLoader.getExtensions().runtime.invalidate();
		}
	}));
