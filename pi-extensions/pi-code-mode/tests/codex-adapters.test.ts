import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import codexCore from "../../pi-codex-core/src/index.ts";
import codexWeb from "../../pi-codex-web-search/src/index.ts";
import { registerCodeModePolicy } from "../src/contributions.ts";
import { piSession, scratch } from "./helpers.ts";
import { grammarResponse, type FixtureCall } from "./grammar-fixtures.ts";
import { Type } from "typebox";

const host = process.env.CODE_MODE_TEST_HOST;
assert(host, "CODE_MODE_TEST_HOST required");
process.env.XDG_STATE_HOME = await scratch("codex-adapter-state");

async function configure(t: TestContext, hosted = false) {
	const old = process.env.PI_CODING_AGENT_DIR;
	const dir = await scratch("codex-adapter-config");
	process.env.PI_CODING_AGENT_DIR = dir;
	t.after(() => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; });
	const config = join(dir, "extensions/pi-codex-minimal-tools");
	await mkdir(config, { recursive: true });
	await writeFile(join(config, "config.json"), JSON.stringify({ webSocketEnabled: false }));
	await writeFile(join(config, "models.json"), JSON.stringify({ version: 1, models: [{
		id: "s1-fixture/s1", extends: "openai/gpt-5.5", responses: { providerShim: hosted, endpoint: "openai", transport: "sse", websocketPrewarm: false },
		tools: { applyPatch: "function", webSearch: { implementation: hosted ? "hosted" : "standalone", contentTypes: ["text"] }, imageGeneration: false, viewImage: false },
		compaction: "pi",
	}] }));
}
function transport(t: TestContext, api: string, search: (request: Request) => Promise<Response>) {
	const steps: Array<FixtureCall | "wait" | undefined> = [];
	const original = globalThis.fetch;
	let count = 0;
	globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		assert.equal(new URL(request.url).origin, "https://s1-fixture.invalid");
		if (new URL(request.url).pathname.endsWith("/alpha/search")) return search(request);
		assert(steps.length, "unexpected LLM request");
		const body = await request.json();
		let call = steps.shift();
		if (call === "wait") {
			const id = [...JSON.stringify(body).matchAll(/cm-[a-f0-9-]{36}/g)].at(-1)?.[0];
			assert(id);
			call = { name: "wait", args: { cell_id: id, yield_time_ms: 10000 } };
		}
		return grammarResponse(api, call, `adapter_${++count}`);
	};
	t.after(() => { globalThis.fetch = original; });
	return {
		steps,
		exec(code: string) { steps.push({ name: "exec", args: { code, yield_time_ms: 0 } }, "wait", undefined); },
	};
}
async function until(predicate: () => boolean) {
	for (let i = 0; i < 500 && !predicate(); i++) await delay(10);
	assert(predicate(), "Adapter did not reach the expected lifecycle state");
}
const patch = (path: string) => `*** Begin Patch\n*** Add File: ${path}\n+created-by-codex-adapter\n*** End Patch\n`;

for (const reverse of [false, true]) test(`S3 optional owners ${reverse ? "reversed/duplicated" : "normal"}: grants, real patch/search and policies`, { timeout: 20000 }, async (t) => {
	await configure(t);
	let network = 0, deny = false;
	const http = transport(t, "openai-completions", async (request) => {
		network++;
		const body = await request.json();
		assert.deepEqual(body.commands.search_query, [{ q: "fixture" }]);
		assert.equal(request.headers.get("authorization"), "Bearer fixture-not-real");
		return Response.json({ output: "private-search-value", results: [{ title: "fixture", url: "https://example.invalid/" }] });
	});
	const f = await piSession(t, { host, grant: true, tools: "codex_core__apply_patch,codex_web__web_search",
		factoryFirst: reverse, factories: [...(reverse ? [codexWeb, codexCore, codexWeb, codexCore] : [codexCore, codexWeb]), (pi) => {
			registerCodeModePolicy(pi, {
				id: "adapter_guard",
				before(call) { if (deny && call.name === "codex_core__apply_patch") return { block: true, reason: "fixture patch denial" }; },
				after(call, value) { return call.name === "codex_web__web_search" ? { text: "redacted-search", results: [] } : value; },
			});
		}] });
	http.exec(`text(await tools.codex_web__web_search({search_query:[{q:"fixture"}]})); text(await tools.codex_core__apply_patch({input:${JSON.stringify(patch("proof.txt"))}}))`);
	await f.session.prompt("Run the two explicitly granted adapters.");
	assert.equal(http.steps.length, 0);
	assert.equal(network, 1);
	assert.equal(await readFile(join(f.cwd, "proof.txt"), "utf8"), "created-by-codex-adapter\n");
	const results = f.session.messages.filter((message) => message.role === "toolResult");
	assert(results.every((message) => !message.isError));
	assert.match(JSON.stringify(results), /redacted-search/);
	assert.doesNotMatch(JSON.stringify(results), /private-search-value/);
	assert(f.session.getActiveToolNames().includes("apply_patch"), "mixed keeps cooperating owners direct");
	deny = true;
	http.exec(`await tools.codex_core__apply_patch({input:${JSON.stringify(patch("denied.txt"))}})`);
	await f.session.prompt("Attempt a denied patch.");
	await assert.rejects(readFile(join(f.cwd, "denied.txt")));
	assert.equal(network, 1);
	assert(f.session.messages.some((message) => message.role === "toolResult" && message.isError && JSON.stringify(message.content).includes("fixture patch denial")));
	assert.deepEqual(f.errors, []);
});

test("S3 optional owners: ungranted adapters are absent, hosted search is never called as a placeholder", { timeout: 20000 }, async (t) => {
	for (const hosted of [false, true]) await t.test(hosted ? "hosted" : "ungranted", async (child) => {
		await configure(child, hosted);
		const api = hosted ? "openai-responses" : "openai-completions";
		let network = 0;
		const http = transport(child, api, async () => { network++; throw new Error("No standalone request is authorized"); });
		const f = await piSession(child, { host, grant: true, api,
			tools: hosted ? "codex_web__web_search" : undefined, factories: [codexCore, codexWeb] });
		http.exec("text(typeof tools.codex_web__web_search); text(typeof tools.codex_core__apply_patch)");
		await f.session.prompt("Inspect nested availability without invoking direct tools.");
		assert.equal(network, 0);
		const last = [...f.session.messages].reverse().find((message) => message.role === "toolResult");
		assert(last?.role === "toolResult" && !last.isError);
		assert.match(JSON.stringify(last.content), /undefined\\nundefined/);
		assert.doesNotMatch(f.session.getAllTools().find((tool) => tool.name === "exec")!.description, /tools\.codex_web__web_search/);
	});
});

test("S3 optional search: terminate aborts an in-flight owner request and settles the cell", { timeout: 20000 }, async (t) => {
	await configure(t);
	let started = false, aborted = false;
	const http = transport(t, "openai-completions", async (request) => {
		started = true;
		return new Promise<Response>((_resolve, reject) => {
			const abort = () => { aborted = true; reject(new Error("fixture search aborted")); };
			request.signal.addEventListener("abort", abort, { once: true });
			if (request.signal.aborted) abort();
		});
	});
	const f = await piSession(t, { host, grant: true, tools: "codex_web__web_search", factories: [codexWeb] });
	http.steps.push({ name: "exec", args: { code: "await tools.codex_web__web_search({search_query:[{q:'fixture'}]})", yield_time_ms: 0 } }, undefined);
	await f.session.prompt("Start search and yield.");
	await until(() => started);
	const first = f.session.messages.find((message) => message.role === "toolResult");
	assert(first?.role === "toolResult");
	const id = (first.details as { cellId: string }).cellId;
	http.steps.push({ name: "wait", args: { cell_id: id, terminate: true, yield_time_ms: 10000 } }, undefined);
	await f.session.prompt("Terminate the running search.");
	assert(aborted);
	const last = [...f.session.messages].reverse().find((message) => message.role === "toolResult");
	assert(last?.role === "toolResult" && !last.isError);
	assert.equal((last.details as { state: string }).state, "terminated");
});

for (const reverse of [false, true]) test(`U3 Codex cooperative hiding survives activation and restores (${reverse})`, async (t) => {
	await configure(t);
	const f = await piSession(t, { host, grant: true, tools: "codex_core__apply_patch,codex_web__web_search",
		visibility: "hide-bridged", factoryFirst: reverse, factories: reverse ? [codexWeb, codexCore, codexWeb, codexCore] : [codexCore, codexWeb] });
	await until(() => !f.session.getActiveToolNames().includes("apply_patch") && !f.session.getActiveToolNames().includes("web_search"));
	assert(!f.session.getActiveToolNames().includes("apply_patch"));
	assert(!f.session.getActiveToolNames().includes("web_search"));
	f.session.setThinkingLevel("low");
	assert(!f.session.getActiveToolNames().includes("apply_patch"));
	assert(!f.session.getActiveToolNames().includes("web_search"));
	await f.session.prompt("/code-mode off");
	assert(f.session.getActiveToolNames().includes("apply_patch"));
	assert(f.session.getActiveToolNames().includes("web_search"));
	assert.deepEqual(f.errors, []);
});

test("U3 Codex cannot claim a foreign first-registration winner by name", async (t) => {
	await configure(t);
	const f = await piSession(t, { host, grant: true, tools: "codex_core__apply_patch", visibility: "hide-bridged",
		expectedToolConflict: "apply_patch",
		factories: [(pi) => pi.registerTool({ name: "apply_patch", label: "Foreign", description: "Foreign first owner",
			parameters: Type.Object({}), async execute() { return { content: [], details: {} }; } }), codexCore] });
	await delay(30); // contribution refresh must finish before checking ownership
	assert.equal(f.session.getAllTools().find((tool) => tool.name === "apply_patch")?.description, "Foreign first owner");
	assert(f.session.getActiveToolNames().includes("apply_patch"));
	f.session.setActiveToolsByName(f.session.getActiveToolNames().filter((name) => name !== "apply_patch"));
	f.session.setThinkingLevel("low");
	assert(!f.session.getActiveToolNames().includes("apply_patch"), "old owner must not reactivate foreign tool");
	await f.session.prompt("/code-mode off");
	assert(!f.session.getActiveToolNames().includes("apply_patch"));
});
