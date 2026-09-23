import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import codexCore from "../../pi-codex-core/src/index.ts";
import codexWeb from "../../pi-codex-web-search/src/index.ts";
import { getCodexBroker, type CodexBroker } from "../../pi-codex-runtime/src/broker.ts";
import { registerCodeModeContribution, registerCodeModeOwnedTool } from "../../pi-codex-runtime/src/code-mode-contributions.ts";
import { piSession, scratch } from "./helpers.ts";

for (const first of [false, true]) test(`Codex tree arbitration and suppression, owner first=${first}`, async (t) => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const directory = await scratch("codex-tree");
	process.env.PI_CODING_AGENT_DIR = directory;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	});
	const config = join(directory, "extensions/pi-codex-minimal-tools");
	await mkdir(config, { recursive: true });
	await writeFile(join(config, "config.json"), JSON.stringify({ webSocketEnabled: false }));
	await writeFile(join(config, "models.json"), JSON.stringify({ version: 1, models: [{
		id: "s1-fixture/s1", extends: "openai/gpt-5.5",
		responses: { providerShim: false, websocketPrewarm: false },
		tools: { applyPatch: "function", webSearch: { implementation: "standalone", contentTypes: ["text"] }, imageGeneration: false, viewImage: false },
		compaction: "pi",
	}] }));
	let broker!: CodexBroker;
	const f = await piSession(t, {
		host: "/fixture-not-executed", grant: true, factoryFirst: first,
		tools: "codex_core__apply_patch,codex_web__web_search", visibility: "hide-bridged",
		factories: [codexCore, codexWeb, (pi) => { broker = getCodexBroker(pi); }],
	});
	await delay(0);
	const tools = f.session.getAllTools().map(({ name, description, parameters }) => ({ name, description, parameters: structuredClone(parameters) }));
	const full = f.session.sessionManager.appendMessage({ role: "system", content: "", toolsAdded: tools, timestamp: Date.now() });
	const empty = f.session.sessionManager.appendMessage({
		role: "system", content: "", toolsRemoved: tools.map(({ name }) => ({ name })), timestamp: Date.now(),
	});
	await f.session.navigateTree(full, { summarize: false });
	await delay(0);
	for (const name of ["apply_patch", "web_search", "edit", "write"]) assert(!f.session.getActiveToolNames().includes(name), name);
	await f.session.prompt("/code-mode visibility mixed");
	broker.tools.get("apply_patch")!.codeModeOwner!.control!.projectActive(false);
	broker.tools.get("web_search")!.codeModeOwner!.control!.projectActive(false);
	await f.session.navigateTree(empty, { summarize: false });
	await f.session.navigateTree(full, { summarize: false });
	assert(!f.session.getActiveToolNames().includes("apply_patch"));
	assert(!f.session.getActiveToolNames().includes("web_search"));
	assert(f.session.getActiveToolNames().includes("edit"));
	assert(f.session.getActiveToolNames().includes("write"));
	await writeFile(join(config, "config.json"), JSON.stringify({ enabled: false, webSocketEnabled: false }));
	broker.tools.get("apply_patch")!.codeModeOwner!.control!.projectActive(true);
	await f.session.navigateTree(empty, { summarize: false });
	await f.session.navigateTree(full, { summarize: false });
	await delay(0);
	assert(!f.session.getActiveToolNames().includes("apply_patch"), "profile kill switch wins over intent and history");
	assert.doesNotMatch(f.session.getAllTools().find((tool) => tool.name === "exec")!.description, /tools\.codex_core__apply_patch/);
	assert.deepEqual(f.errors, []);
});

for (const first of [false, true]) test(`Codex tree drops old native suppression receipts, owner first=${first}`, async (t) => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const directory = await scratch("codex-tree-no-mutation");
	process.env.PI_CODING_AGENT_DIR = directory;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	});
	const config = join(directory, "extensions/pi-codex-minimal-tools");
	await mkdir(config, { recursive: true });
	await writeFile(join(config, "config.json"), JSON.stringify({ webSocketEnabled: false }));
	await writeFile(join(config, "models.json"), JSON.stringify({ version: 1, models: [{
		id: "s1-fixture/s1", extends: "openai/gpt-5.5",
		responses: { providerShim: false, websocketPrewarm: false },
		tools: { applyPatch: "function", webSearch: false, imageGeneration: false, viewImage: false },
		compaction: "pi",
	}] }));
	let reconcile!: () => void;
	const f = await piSession(t, {
		host: "/fixture-not-executed", grant: true, factoryFirst: first,
		tools: "codex_core__apply_patch", visibility: "hide-bridged",
		factories: [codexCore, (pi) => {
			reconcile = () => pi.events.emit("@oai404iao/pi-code-mode:direct-owner-changed/v1", { version: 1 });
		}], activeTools: ["read", "edit", "write", "apply_patch", "exec", "wait"],
	});
	await delay(0);
	const tools = f.session.getAllTools().map(({ name, description, parameters }) => ({ name, description, parameters: structuredClone(parameters) }));
	const full = f.session.sessionManager.appendMessage({ role: "system", content: "", toolsAdded: tools, timestamp: Date.now() });
	const restricted = f.session.sessionManager.appendMessage({
		role: "system", content: "", toolsRemoved: [{ name: "edit" }, { name: "write" }], timestamp: Date.now(),
	});
	await f.session.navigateTree(full, { summarize: false });
	await f.session.navigateTree(restricted, { summarize: false });
	await delay(0);
	await writeFile(join(config, "config.json"), JSON.stringify({ enabled: false, webSocketEnabled: false }));
	reconcile();
	await f.session.prompt("/code-mode off");
	for (const name of ["edit", "write", "apply_patch"]) {
		assert(!f.session.getActiveToolNames().includes(name), `must not restore ${name} from the previous branch`);
	}
	assert.deepEqual(f.errors, []);
});

for (const first of [false, true]) for (const initiallyActive of [false, true]) {
	test(`Codex tree preserves explicit allowlist with autoEnable=false, owner first=${first}, active=${initiallyActive}`, async (t) => {
		const previous = process.env.PI_CODING_AGENT_DIR;
		const directory = await scratch("codex-tree-allowlist");
		process.env.PI_CODING_AGENT_DIR = directory;
		t.after(() => {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
		});
		const config = join(directory, "extensions/pi-codex-minimal-tools");
		await mkdir(config, { recursive: true });
		await writeFile(join(config, "config.json"), JSON.stringify({ autoEnable: false, webSocketEnabled: false }));
		await writeFile(join(config, "models.json"), JSON.stringify({ version: 1, models: [{
			id: "s1-fixture/s1", extends: "openai/gpt-5.5",
			responses: { providerShim: false, websocketPrewarm: false },
			tools: { applyPatch: "function", webSearch: { implementation: "standalone", contentTypes: ["text"] }, imageGeneration: false, viewImage: false },
			compaction: "pi",
		}] }));
		const f = await piSession(t, {
			host: "/fixture-not-executed", grant: true, factoryFirst: first, factories: [codexCore, codexWeb],
			tools: "codex_core__apply_patch,codex_web__web_search", visibility: "hide-bridged",
			activeTools: ["read", "edit", "write", "exec", "wait", ...(initiallyActive ? ["apply_patch", "web_search"] : [])],
		});
		await delay(0);
		const withoutSystem = f.session.sessionManager.appendCustomEntry("fixture", {});
		const tools = f.session.getAllTools().map(({ name, description, parameters }) => ({ name, description, parameters: structuredClone(parameters) }));
		const full = f.session.sessionManager.appendMessage({ role: "system", content: "", toolsAdded: tools, timestamp: Date.now() });
		await f.session.navigateTree(withoutSystem, { summarize: false });
		await f.session.navigateTree(full, { summarize: false });
		await delay(0);
		assert(!f.session.getActiveToolNames().includes("apply_patch"));
		assert.equal(f.session.getActiveToolNames().includes("edit"), !initiallyActive);
		await f.session.prompt("/code-mode off");
		assert.equal(f.session.getActiveToolNames().includes("apply_patch"), initiallyActive);
		assert.equal(f.session.getActiveToolNames().includes("web_search"), initiallyActive);
		assert.deepEqual(f.errors, []);
	});
}

for (const grantOwner of [false, true]) test(`Codex direct binding cannot be borrowed by a namesake provider, owner grant=${grantOwner}`, async (t) => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const directory = await scratch("codex-namesake");
	process.env.PI_CODING_AGENT_DIR = directory;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	});
	const config = join(directory, "extensions/pi-codex-minimal-tools");
	await mkdir(config, { recursive: true });
	await writeFile(join(config, "config.json"), JSON.stringify({ webSocketEnabled: false }));
	await writeFile(join(config, "models.json"), JSON.stringify({ version: 1, models: [{
		id: "s1-fixture/s1", extends: "openai/gpt-5.5",
		responses: { providerShim: false, websocketPrewarm: false },
		tools: { applyPatch: "function", webSearch: false, imageGeneration: false, viewImage: false }, compaction: "pi",
	}] }));
	const f = await piSession(t, {
		host: "/fixture-not-executed", grant: true, visibility: "hide-bridged",
		tools: `namesake__apply_patch${grantOwner ? ",codex_core__apply_patch" : ""}`,
		factories: [codexCore, (pi) => {
			assert.throws(() => registerCodeModeOwnedTool(pi, {
				name: "apply_patch", description: "replacement", parameters: {},
			}, "namesake"), /Duplicate Code Mode tool definition/);
			assert.equal(getCodexBroker(pi).codeModeDefinitions?.get("apply_patch")?.providerId, "codex_core");
			registerCodeModeContribution(pi, "namesake", () => [{
				name: "apply_patch", description: "Not the Codex owner", parameters: { type: "object", properties: {} },
				effect: "read", async invoke() { return { value: null }; },
			}]);
		}],
	});
	await delay(0);
	assert.equal(f.session.getActiveToolNames().includes("apply_patch"), !grantOwner);
	assert.match(f.session.getAllTools().find((tool) => tool.name === "exec")!.description, /tools\.namesake__apply_patch/);
	await f.session.prompt("/code-mode off");
	assert(f.session.getActiveToolNames().includes("apply_patch"));
	assert.deepEqual(f.errors, []);
});
