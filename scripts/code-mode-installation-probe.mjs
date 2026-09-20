// Copied into the isolated consumer: bare imports MUST resolve there.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SettingsManager, SessionManager, VERSION } from "@earendil-works/pi-coding-agent";

const root = process.cwd();
assert.equal(VERSION, "0.85.1");
const sdkPath = realpathSync(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
assert(sdkPath.startsWith(`${root}/node_modules/`));
const packageRoot = join(root, "node_modules/@oai404iao/pi-code-mode");
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
assert(!Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies })
	.some((name) => name.startsWith("@oai404iao/pi-codex")));
const cwd = join(root, "cwd");
writeFileSync(join(cwd, "fixture.txt"), "tarball-runtime-read");
// Exercise the public TypeScript subpath through the real Pi extension loader,
// not Node's unsupported raw node_modules type stripping or a workspace alias.
const contributionPath = join(root, "contribution.ts");
writeFileSync(contributionPath, `
import { createCodeModeDirectBinding, registerCodeModeTools } from "@oai404iao/pi-code-mode/contributions";
import { Type } from "typebox";
import { fileURLToPath } from "node:url";
export default function contribution(pi) {
	pi.registerTool({ name: "installed_lookup", label: "Lookup", description: "Installed direct lookup",
		parameters: Type.Object({}), async execute() { throw new Error("Use the contributed adapter"); } });
	const owner = createCodeModeDirectBinding(pi, { name: "installed_lookup", sourcePath: fileURLToPath(import.meta.url) });
	const registration = registerCodeModeTools(pi, { id: "fixture", tools: [{
		name: "read", description: "Installed public contribution", parameters: Type.Object({}), effect: "read",
		direct: owner.binding,
		async invoke() { return { value: "installed-contribution" }; },
	}] });
	pi.on("session_start", () => { owner.setActive(true); });
	pi.on("session_shutdown", () => { registration.dispose(); owner.dispose(); });
}
`);
let requests = 0;
globalThis.fetch = async (input, init) => {
	const request = new Request(input, init);
	assert.equal(new URL(request.url).origin, "https://s1-fixture.invalid");
	const body = await request.json();
	requests++;
	assert(requests <= 3);
	assert(body.tools.some((tool) => tool.type === "custom" && tool.custom?.name === "exec"));
	assert(body.tools.some((tool) => tool.function?.name === "wait"));
	assert(!body.tools.some((tool) => tool.function?.name === "installed_lookup"));
	assert(body.tools.some((tool) => tool.function?.name === "bash"), "unadapted direct tools remain");
	if (requests === 3) {
		assert.match(JSON.stringify(body.messages), /tarball-runtime-read/);
		assert.match(JSON.stringify(body.messages), /installed-contribution/);
	}
	const cellId = JSON.stringify(body.messages).match(/cm-[a-f0-9-]{36}/)?.[0];
	if (requests === 2) assert(cellId);
	const delta = requests <= 2
		? { role: "assistant", tool_calls: [{ index: 0, id: `call_${requests}`, ...(requests === 1
			? { type: "custom", custom: { name: "exec", input: "// @exec: {\"yield_time_ms\":0}\ntext((await tools.read({path:'fixture.txt'})).text); text(await tools.fixture__read({}))" } }
			: { type: "function", function: { name: "wait", arguments: JSON.stringify({ cell_id: cellId, yield_time_ms: 10000 }) } }),
		}] }
		: { role: "assistant", content: "Done" };
	const chunk = (value, finish_reason) => `data: ${JSON.stringify({
		id: "s1", object: "chat.completion.chunk", created: 1, model: "s1",
		choices: [{ index: 0, delta: value, finish_reason }],
	})}\n\n`;
	return new Response(chunk(delta, null) + chunk({}, requests <= 2 ? "tool_calls" : "stop") + "data: [DONE]\n\n",
		{ headers: { "content-type": "text/event-stream" } });
};
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
const loader = new DefaultResourceLoader({
	cwd, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager,
	noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
	additionalExtensionPaths: [join(packageRoot, "index.ts"), contributionPath],
});
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const loaded = loader.getExtensions();
loaded.runtime.flagValues.set("code-mode-host", process.env.CODE_MODE_TEST_HOST);
loaded.runtime.flagValues.set("code-mode-read-root", cwd);
loaded.runtime.flagValues.set("code-mode-tools", "fixture__read");
loaded.runtime.flagValues.set("code-mode-visibility", "hide-bridged");
loaded.runtime.flagValues.set("code-mode-protocol", "auto");
const modelRuntime = await ModelRuntime.create({
	authPath: join(root, "agent/auth.json"), modelsPath: null, modelsStorePath: join(root, "agent/models-store.json"), allowModelNetwork: false,
});
modelRuntime.registerProvider("s1-fixture", {
	api: "openai-completions", apiKey: "fixture-not-real", baseUrl: "https://s1-fixture.invalid",
	models: [{ id: "s1", name: "S1", reasoning: false, input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000,
		compat: { supportsOpenAIGrammarTools: true } }],
});
const { session } = await createAgentSession({
	cwd, agentDir: process.env.PI_CODING_AGENT_DIR, modelRuntime, model: modelRuntime.getModel("s1-fixture", "s1"),
	resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(cwd), thinkingLevel: "off",
});
const errors = [];
try {
	// Pi 0.85.1 reload emits session_start only when a UI/action/error binding
	// is retained. Match the real print frontend's error binding, not mode alone.
	await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.error) });
	await session.prompt("Read fixture.txt through exec");
	assert.equal(requests, 3);
	const result = session.messages.find((message) => message.role === "toolResult" && message.toolName === "wait");
	assert(result && !result.isError);
	assert.match(JSON.stringify(result.content), /tarball-runtime-read/);
	await session.prompt("/code-mode off");
	assert(!session.getActiveToolNames().includes("exec"));
	assert(session.getActiveToolNames().includes("installed_lookup"));
	assert.deepEqual(errors, []);
	await session.reload();
	assert(!session.getActiveToolNames().includes("installed_lookup"), "fresh reload re-applies explicit CLI grants and visibility");
	await session.prompt("/code-mode off");
	assert(session.getActiveToolNames().includes("installed_lookup"));
	assert.deepEqual(errors, []);
	console.log(`PASS isolated S3/S4 production tarball, native grammar, public owner cooperation, hide/restore/reload, exec/wait, Pi ${VERSION}, real Host, no Codex packages`);
} finally {
	await session.abort();
	await session.prompt("/code-mode off");
	session.dispose();
	loaded.runtime.invalidate();
}
