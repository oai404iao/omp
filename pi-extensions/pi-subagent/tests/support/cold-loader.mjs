import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const [cwd, countText, sdkModule, aiModule] = process.argv.slice(2);
process.env.PI_CODING_AGENT_DIR = cwd;
const { createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager } =
	await import(sdkModule ?? "@earendil-works/pi-coding-agent");
const { createAssistantMessageEventStream } = await import(aiModule ?? "@earendil-works/pi-ai");
const count = Number(countText);
mkdirSync(cwd, { recursive: true });
writeFileSync(join(cwd, "subagent.json"), JSON.stringify({ maxConcurrentAgents: count, openAIIdentity: true }));
writeFileSync(join(cwd, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
const modelRuntime = await ModelRuntime.create({
	authPath: join(cwd, "auth.json"), modelsPath: null,
	modelsStorePath: join(cwd, "model-store.json"), allowModelNetwork: false,
});
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
let requests = 0;
modelRuntime.registerProvider("scripted", {
	baseUrl: "http://scripted.invalid", apiKey: "test", api: "openai-responses",
	models: [{ id: "echo", name: "Echo", reasoning: false, input: ["text"], cost: usage.cost,
		contextWindow: 100000, maxTokens: 1000 }],
	streamSimple: model => {
		requests++;
		const events = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const message = { role: "assistant", content: [{ type: "text", text: "done" }],
				api: model.api, provider: model.provider, model: model.id, usage, stopReason: "stop", timestamp: Date.now() };
			events.push({ type: "done", reason: "stop", message });
			events.end();
		});
		return events;
	},
});
const services = await createAgentSessionServices({ cwd, agentDir: cwd, modelRuntime,
	resourceLoaderOptions: { noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
		additionalExtensionPaths: [resolve(import.meta.dirname, "../../index.ts")] } });
assert.deepEqual(services.diagnostics, []);
const manager = SessionManager.create(cwd, join(cwd, "sessions"));
const { session } = await createAgentSessionFromServices({ services, sessionManager: manager,
	model: modelRuntime.getModel("scripted", "echo"), thinkingLevel: "off" });
try {
	const errors = [];
	await session.bindExtensions({ mode: "print", onError: error => errors.push(error) });
	const call = async (name, args) => {
		const result = await session.getToolDefinition(name).execute(name, args, undefined, undefined,
			session.extensionRunner.createContext());
		assert.ok(!result.isError, JSON.stringify(result));
		return result.details;
	};
	const idle = async () => {
		const deadline = Date.now() + 30000;
		for (;;) {
			const list = await call("list_agents", {});
			const children = list.agents.filter(agent => agent.agent_name !== "/root");
			assert.ok(!children.some(agent => agent.agent_status === "errored"), JSON.stringify(children));
			if (children.length === count && children.every(agent => agent.agent_status === "completed")) return;
			assert.ok(Date.now() < deadline, JSON.stringify(children));
			await new Promise(done => setTimeout(done, 10));
		}
	};
	await Promise.all(Array.from({ length: count }, (_, index) => call("spawn_agent", {
		task_name: `worker_${index}`, message: "offline fixture", fork_turns: "none",
	})));
	await idle();
	assert.equal(requests, count);
	await call("followup_task", { target: "worker_0", message: "cold resume" });
	await idle();
	assert.equal(requests, count + 1);
	await session.reload();
	await call("followup_task", { target: "worker_0", message: "resume after extension reload" });
	await idle();
	assert.equal(requests, count + 2);
	assert.deepEqual(errors, []);
} finally {
	await session.dispose();
	services.resourceLoader.getExtensions().runtime.invalidate();
}
