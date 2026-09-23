// Copied into the isolated consumer: bare imports MUST resolve there.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, realpathSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SettingsManager, SessionManager, VERSION } from "@earendil-works/pi-coding-agent";

const root = process.cwd();
assert.equal(VERSION, "0.86.1");
const sdkPath = realpathSync(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
assert(sdkPath.startsWith(`${root}/node_modules/`));
const packageRoot = join(root, "node_modules/@oai404iao/pi-code-mode");
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
assert(!Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies })
	.some((name) => name.startsWith("@oai404iao/pi-codex")));
const cwd = join(root, "cwd");
const configDirectory = join(process.env.PI_CODING_AGENT_DIR, "extensions/pi-code-mode");
mkdirSync(configDirectory, { recursive: true });
writeFileSync(join(configDirectory, "config.json"), JSON.stringify({
	version: 1, hostPath: process.env.CODE_MODE_TEST_HOST, protocol: "auto", visibility: "hide-bridged", maxCells: 2,
	requiredPolicies: ["fixture__guard"],
}));
writeFileSync(join(cwd, "fixture.txt"), "tarball-runtime-read");
// Exercise the public TypeScript subpath through the real Pi extension loader,
// not Node's unsupported raw node_modules type stripping or a workspace alias.
const contributionPath = join(root, "contribution.ts");
writeFileSync(contributionPath, `
import { DISCOVER, createCodeModeDirectBinding, registerCodeModeTools, registerCodeModeObserver,
	registerCodeModePolicy, registerCodeModeApproval, unsettledEffect, isUnsettledEffect } from "@oai404iao/pi-code-mode/contributions";
import { registerPiBuiltinLs } from "@oai404iao/pi-code-mode/builtin-adapters";
import { Type } from "typebox";
import { fileURLToPath } from "node:url";
export default function contribution(pi) {
	if (!isUnsettledEffect(unsettledEffect("installed structural contract"))) throw new Error("Missing unsettled contract");
	globalThis.__codeModeReceipts = [];
	globalThis.__codeModeApprovals = 0;
	const stopApproval = registerCodeModeApproval(pi, { id: "installed", approve() {
		globalThis.__codeModeApprovals++; return true;
	} });
	const stopPolicy = registerCodeModePolicy(pi, { id: "fixture__guard", resolve() {
		return { id: "fixture__guard", approval: "installed" };
	} });
	const stopObserver = registerCodeModeObserver(pi, { id: "installed", complete(receipt) {
		globalThis.__codeModeReceipts.push({ frozen: Object.isFrozen(receipt),
			privateFields: "input" in receipt || "value" in receipt, origin: receipt.originToolCallId });
	} });
	pi.registerTool({ name: "installed_lookup", label: "Lookup", description: "Installed direct lookup",
		parameters: Type.Object({}), async execute() { throw new Error("Use the contributed adapter"); } });
	const owner = createCodeModeDirectBinding(pi, { name: "installed_lookup", sourcePath: fileURLToPath(import.meta.url) });
	const registration = registerCodeModeTools(pi, { id: "fixture", tools: [{
		name: "read", description: "Installed public contribution", parameters: Type.Object({}), outputSchema: Type.String(), effect: "read",
		direct: owner.binding, approval: "installed", requires: ["prepared-frozen-args/1"],
		async invoke() { return { value: "installed-contribution" }; },
	}] });
	let exposed = 0, blocked = false;
	pi.events.emit(DISCOVER, { version: 1,
		provider(value) { exposed += value.tools.length; },
		policy(value) { blocked = value.before?.({})?.block === true; },
	});
	globalThis.__legacyProtection = { exposed, blocked };
	registerPiBuiltinLs(pi);
	pi.on("session_start", () => { owner.setActive(true); });
	pi.on("session_shutdown", () => { registration.dispose(); owner.dispose(); stopObserver(); stopPolicy(); stopApproval(); });
}
`);
let requests = 0;
globalThis.fetch = async (input, init) => {
	const request = new Request(input, init);
	assert.equal(new URL(request.url).origin, "https://s1-fixture.invalid");
	const body = await request.json();
	requests++;
	assert(requests <= 4);
	assert(body.tools.some((tool) => tool.type === "custom" && tool.custom?.name === "exec"));
	assert(body.tools.some((tool) => tool.function?.name === "wait"));
	assert(!body.tools.some((tool) => tool.function?.name === "installed_lookup"));
	assert(body.tools.some((tool) => tool.function?.name === "bash"), "unadapted direct tools remain");
	if (requests === 4) {
		assert.match(JSON.stringify(body.messages), /tarball-runtime-read/);
		assert.match(JSON.stringify(body.messages), /installed-contribution/);
		assert.match(JSON.stringify(body.messages), /installed-sibling/);
		assert.match(JSON.stringify(body.messages), /example/);
		assert.match(JSON.stringify(body.messages), /fixture.txt/);
	}
	const cellId = JSON.stringify(body.messages).match(/cm-[a-f0-9-]{36}/)?.[0];
	if (requests === 3) assert(cellId);
	const delta = requests <= 3
		? { role: "assistant", tool_calls: [{ index: 0, id: `call_${requests}`, ...(requests === 1
			? { type: "custom", custom: { name: "exec", input: "// @exec: {\"yield_time_ms\":0}\ntext((await tools.read({path:'fixture.txt'})).text); text(await tools.fixture__read({})); text(await tools.pi_builtin__ls({path:'.'})); text(await tools.inventory__lookup({name:'sample'})); await new Promise(r=>setTimeout(r,500))" } }
			: requests === 2 ? { type: "custom", custom: { name: "exec", input: "// @exec: {\"yield_time_ms\":10000}\ntext('installed-sibling')" } }
			: { type: "function", function: { name: "wait", arguments: JSON.stringify({ cell_id: cellId, yield_time_ms: 10000 }) } }),
		}] }
		: { role: "assistant", content: "Done" };
	const chunk = (value, finish_reason) => `data: ${JSON.stringify({
		id: "s1", object: "chat.completion.chunk", created: 1, model: "s1",
		choices: [{ index: 0, delta: value, finish_reason }],
	})}\n\n`;
	return new Response(chunk(delta, null) + chunk({}, requests <= 3 ? "tool_calls" : "stop") + "data: [DONE]\n\n",
		{ headers: { "content-type": "text/event-stream" } });
};
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
const loader = new DefaultResourceLoader({
	cwd, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager,
	noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
	additionalExtensionPaths: [join(packageRoot, "index.ts"), contributionPath, join(packageRoot, "examples/inventory.ts")],
});
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const loaded = loader.getExtensions();
loaded.runtime.flagValues.set("code-mode-read-root", cwd);
loaded.runtime.flagValues.set("code-mode-tools", "fixture__read,pi_builtin__ls,inventory__lookup");
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
	// Pi 0.86.1 reload emits session_start only when a UI/action/error binding
	// is retained. Match the real print frontend's error binding, not mode alone.
	await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.error) });
	assert.match(session.getAllTools().find((tool) => tool.name === "exec").description, /Promise<string>/);
	await session.prompt("/code-mode doctor");
	await session.prompt("Read fixture.txt through exec");
	assert.equal(requests, 4);
	const result = session.messages.find((message) => message.role === "toolResult" && message.toolName === "wait");
	assert(result && !result.isError);
	assert.match(JSON.stringify(result.content), /tarball-runtime-read/);
	const sibling = session.messages.find((message) => message.role === "toolResult" && message.toolCallId === "call_2");
	assert(sibling && !sibling.isError);
	assert.equal(sibling.details.epoch, result.details.epoch);
	assert.equal(sibling.details.runtimeReset, false);
	assert.equal(globalThis.__codeModeReceipts.length, 4);
	assert(globalThis.__codeModeReceipts.every(r => r.frozen && !r.privateFields && r.origin === "call_1"));
	assert.equal(globalThis.__codeModeApprovals, 4, "required global policy enforces local and both I3 pilot calls");
	assert.deepEqual(globalThis.__legacyProtection, { exposed: 0, blocked: true });
	await session.prompt("/code-mode off");
	assert(!session.getActiveToolNames().includes("exec"));
	assert(session.getActiveToolNames().includes("installed_lookup"));
	assert.deepEqual(errors, []);
	await session.reload();
	assert(!session.getActiveToolNames().includes("installed_lookup"), "fresh reload re-applies explicit CLI grants and visibility");
	await session.prompt("/code-mode off");
	assert(session.getActiveToolNames().includes("installed_lookup"));
	assert.deepEqual(errors, []);
	console.log(`PASS isolated I1-I3 production tarball, v2 features/structural error, required policy/approval and legacy deny, both opt-in pilots, config/doctor/output schema, native grammar, public owner cooperation, hide/restore/reload, two shared-Host cells, Pi ${VERSION}, real Host, no Codex packages`);
} finally {
	await session.abort();
	await session.prompt("/code-mode off");
	session.dispose();
	loaded.runtime.invalidate();
}
