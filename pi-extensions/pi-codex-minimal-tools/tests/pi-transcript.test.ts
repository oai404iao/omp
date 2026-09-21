import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { InMemoryCredentialStore, getCurrentSystemPrompt, getCurrentTools, normalizeContext } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { projectCodexTranscript } from "@oai404iao/pi-codex-core/internal/providers/openai-codex/transcript";
import { parseStreamingJson } from "@oai404iao/pi-codex-runtime/internal/providers/responses/text";
import { registerResponsesProviderRuntime } from "../src/extension/provider-runtime.js";
import { withCodexSettings } from "./support/provider-lifecycle-test-support.js";
import { codexJwt } from "./support/openai-codex-test-support.js";

test("transcript projection replays section patches and tool replacement without mutating history", () => {
	const read = { name: "read", description: "Read", parameters: Type.Object({}) };
	const context = normalizeContext({
		systemPrompt: "BASE", tools: [read],
		messages: [
			{ role: "user", content: "question", timestamp: 1 },
			{ role: "system", content: "NOTE", sections: { rules: "old" }, timestamp: 2 },
			{ role: "system", content: "", sections: { rules: "new" }, toolsRemoved: [{ name: "read" }],
				toolsAdded: [{ ...read, name: "lookup" }], timestamp: 3 },
		],
	});
	const before = structuredClone(context);
	const projected = projectCodexTranscript(context);
	assert.equal(projected.systemPrompt, getCurrentSystemPrompt(context.messages));
	assert.deepEqual(projected.tools, getCurrentTools(context.messages));
	assert.deepEqual(projected.tools?.map((tool) => tool.name), ["lookup"]);
	assert.deepEqual(projected.messages.map((message) => message.role), ["user"]);
	assert.deepEqual(context, before);
});

test("streaming function arguments remain JSON objects, including incomplete and non-object input", () => {
	assert.deepEqual(parseStreamingJson('{"value":{"list":[null,true,3]}}'), { value: { list: [null, true, 3] } });
	for (const json of ["", '{"value":', "null", "[]", '"text"', "42"]) assert.deepEqual(parseStreamingJson(json), {});
});

for (const id of ["gpt-5.5", "gpt-6-astra"]) {
	test(`real SDK provider dispatch preserves prompts and dynamic tool state for ${id}`, async () => {
		const provider = id === "gpt-6-astra" ? "openai-codex" : "openai";
		await withCodexSettings({ webSocketEnabled: false }, async (cwd) => {
			const originalFetch = globalThis.fetch;
			const requests: any[] = [];
			globalThis.fetch = async (input, init) => {
				const request = new Request(input, init);
				assert.equal(new URL(request.url).hostname, "transcript.invalid");
				requests.push(await request.json());
				const responseId = `resp_${requests.length}`;
				const item = { type: "message", id: `msg_${requests.length}`, role: "assistant", status: "completed",
					content: [{ type: "output_text", text: "done", annotations: [] }] };
				const events = [
					{ type: "response.created", response: { id: responseId } },
					{ type: "response.output_item.done", output_index: 0, item },
					{ type: "response.completed", response: { id: responseId, status: "completed", output: [item] } },
				];
				return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
					headers: { "content-type": "text/event-stream" },
				});
			};
			const agentDir = join(cwd, "agent");
			const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
			let api: ExtensionAPI;
			let rules = "FIRST_RULES";
			const loader = new DefaultResourceLoader({
				cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noThemes: true,
				noPromptTemplates: true, noContextFiles: true,
				extensionFactories: [(pi) => {
					api = pi;
					registerResponsesProviderRuntime(pi, { getCurrentCwd: () => cwd });
					for (const name of ["audit_first", "audit_second"]) pi.registerTool({
						name, label: name, description: name, parameters: Type.Object({}),
						async execute() { return { content: [{ type: "text", text: "fixture" }], details: {} }; },
					});
					pi.on("before_agent_start", (event) => { event.systemPromptOptions.sections.audit = rules; });
				}],
			});
			await loader.reload();
			assert.deepEqual(loader.getExtensions().errors, []);
			const runtime = await ModelRuntime.create({
				credentials: new InMemoryCredentialStore(), modelsPath: null,
				modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false,
			});
			runtime.registerProvider(provider, {
				api: provider === "openai-codex" ? "openai-codex-responses" : "openai-responses",
				apiKey: codexJwt(), baseUrl: "https://transcript.invalid/v1",
				models: [{ id, name: id, reasoning: true, input: ["text"], contextWindow: 100000, maxTokens: 1000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
			});
			const { session } = await createAgentSession({
				cwd, agentDir, modelRuntime: runtime, model: runtime.getModel(provider, id), settingsManager,
				resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), tools: ["audit_first", "audit_second"],
			});
			try {
				await session.bindExtensions({ mode: "print" });
				api!.setActiveTools(["audit_first"]);
				await session.prompt("FIRST_QUESTION");
				api!.setActiveTools(["audit_second"]);
				rules = "SECOND_RULES";
				await session.prompt("SECOND_QUESTION");
				assert.equal(requests.length, 2);
				for (const [index, body] of requests.entries()) {
					const wire = JSON.stringify(body);
					assert.match(wire, index === 0 ? /FIRST_RULES/ : /SECOND_RULES/);
					assert.match(wire, index === 0 ? /audit_first/ : /audit_second/);
					if (index === 1) {
						assert.doesNotMatch(wire, /FIRST_RULES|audit_first/);
						assert.match(wire, /FIRST_QUESTION/);
					}
					if (id === "gpt-6-astra") assert.equal(body.input[0].type, "additional_tools", JSON.stringify(body));
					else assert.equal(typeof body.instructions, "string");
				}
				assert.equal(session.messages.at(-1)?.role, "assistant");
			} finally {
				await session.abort();
				session.dispose();
				loader.getExtensions().runtime.invalidate();
				globalThis.fetch = originalFetch;
			}
		});
	});
}
