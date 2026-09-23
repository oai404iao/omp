// Runs inside the production consumer: every bare import resolves from tarballs.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";

const root = process.cwd(), cwd = join(root, "cwd"), agentDir = process.env.PI_CODING_AGENT_DIR;
assert.equal(VERSION, process.env.OMP_PI_EXPECTED_VERSION);
assert(realpathSync(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))).startsWith(`${root}/node_modules/`));
const packages = ["pi-code-mode", "pi-codex-core", "pi-codex-web-search", "pi-codex-runtime"];
for (const name of packages) {
	const manifest = JSON.parse(readFileSync(join(root, "node_modules/@oai404iao", name, "package.json"), "utf8"));
	const edges = Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies });
	if (name === "pi-code-mode") assert(!edges.some((edge) => edge.startsWith("@oai404iao/pi-codex")));
	else assert(!edges.includes("@oai404iao/pi-code-mode"), "no reverse dependency on the private package");
}
const config = join(agentDir, "extensions/pi-codex-minimal-tools");
mkdirSync(config, { recursive: true });
writeFileSync(join(config, "config.json"), JSON.stringify({ webSocketEnabled: false }));
writeFileSync(join(config, "models.json"), JSON.stringify({ version: 1, models: [{
	id: "installed-fixture/model", extends: "openai/gpt-5.6-sol",
	responses: { endpoint: "openai", transport: "sse", websocketPrewarm: false },
	tools: { applyPatch: "custom", webSearch: { implementation: "standalone", contentTypes: ["text"] }, imageGeneration: false, viewImage: false },
	compaction: "pi",
}] }));
let requests = 0, searches = 0;
const source = '// @exec: {"yield_time_ms":0}\n'
	+ "text((await tools.codex_web__web_search({search_query:[{q:'installed'}]})).text);"
	+ `text((await tools.codex_core__apply_patch({input:${JSON.stringify("*** Begin Patch\n*** Add File: proof.txt\n+installed-patch\n*** End Patch")}})).summary);`;
globalThis.fetch = async (input, init) => {
	const request = new Request(input, init);
	assert.equal(new URL(request.url).origin, "https://installed-fixture.invalid");
	const body = await request.json();
	if (new URL(request.url).pathname.endsWith("/alpha/search")) {
		searches++;
		assert.equal(request.headers.get("authorization"), "Bearer fixture-not-real");
		return Response.json({ output: "installed-standalone-search", results: [] });
	}
	requests++;
	assert(requests <= 3);
	const namespace = body.input.find((item) => item.type === "additional_tools").tools.find((tool) => tool.name === "functions");
	assert(namespace.tools.some((tool) => tool.name === "exec" && tool.type === "custom"));
	const cell = [...JSON.stringify(body.input).matchAll(/cm-[a-f0-9-]{36}/g)].at(-1)?.[0];
	if (requests === 2) assert(cell);
	if (requests === 3) assert.match(JSON.stringify(body.input), /installed-standalone-search/);
	const item = requests === 1 ? {
		type: "custom_tool_call", id: "ctc_exec", call_id: "call_exec", namespace: "functions", name: "exec", input: source,
	} : requests === 2 ? {
		type: "function_call", id: "fc_wait", call_id: "call_wait", namespace: "functions", name: "wait",
		arguments: JSON.stringify({ cell_id: cell, yield_time_ms: 10000 }),
	} : { type: "message", id: "msg_done", role: "assistant", status: "completed",
		content: [{ type: "output_text", text: "Done", annotations: [] }] };
	const events = [
		{ type: "response.created", response: { id: `resp_${requests}` } },
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.completed", response: { id: `resp_${requests}`, status: "completed", output: [item],
			usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
	];
	return new Response(events.map((event, sequence_number) => `data: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(""),
		{ headers: { "content-type": "text/event-stream" } });
};
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
const loader = new DefaultResourceLoader({
	cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
	additionalExtensionPaths: ["pi-codex-core", "pi-code-mode", "pi-codex-web-search", "pi-codex-core"]
		.map((name) => join(root, "node_modules/@oai404iao", name, "index.ts")),
});
await loader.reload();
const loaded = loader.getExtensions();
assert.deepEqual(loaded.errors, []);
for (const [name, value] of Object.entries({
	"code-mode-host": process.env.CODE_MODE_TEST_HOST, "code-mode-read-root": cwd, "code-mode-protocol": "auto",
	"code-mode-tools": "codex_core__apply_patch,codex_web__web_search", "code-mode-visibility": "hide-bridged",
})) loaded.runtime.flagValues.set(name, value);
const modelRuntime = await ModelRuntime.create({
	authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false,
});
modelRuntime.registerProvider("installed-fixture", {
	api: "openai-responses", apiKey: "fixture-not-real", baseUrl: "https://installed-fixture.invalid/v1",
	models: [{ id: "model", name: "Installed fixture", reasoning: false, input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 2000,
		compat: { supportsOpenAIGrammarTools: true } }],
});
const { session } = await createAgentSession({
	cwd, agentDir, modelRuntime, model: modelRuntime.getModel("installed-fixture", "model"),
	resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(cwd), thinkingLevel: "off",
});
const errors = [];
try {
	await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.error) });
	await session.prompt("Use the explicitly authorized installed adapters.");
	assert.equal(requests, 3);
	assert.equal(searches, 1);
	assert.equal(readFileSync(join(cwd, "proof.txt"), "utf8"), "installed-patch\n");
	assert(session.messages.filter((message) => message.role === "toolResult").every((message) => !message.isError));
	assert(!session.getActiveToolNames().includes("apply_patch"), "explicit cooperating patch owner hidden");
	assert(!session.getActiveToolNames().includes("web_search"), "explicit standalone owner hidden");
	assert.deepEqual(errors, []);
	await session.prompt("/code-mode off");
	assert(!session.getActiveToolNames().includes("exec"));
	assert(session.getActiveToolNames().includes("apply_patch"));
	assert(session.getActiveToolNames().includes("web_search"));
	console.log(`PASS isolated U3 Codex+Code Mode tarballs, Lite grammar/exec/wait, real patch/standalone search, cooperative hide/restore, Pi ${VERSION}, no package back-edges`);
} finally {
	await session.abort();
	await session.prompt("/code-mode off");
	await session.reload();
	await session.prompt("/code-mode off");
	session.dispose();
	loaded.runtime.invalidate();
}
