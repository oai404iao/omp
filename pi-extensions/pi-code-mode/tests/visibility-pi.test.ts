import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCodeModeDirectBinding, registerCodeModeTools, type CodeModeTool } from "../src/contributions.ts";
import { piSession } from "./helpers.ts";

async function until(predicate: () => boolean) {
	for (let i = 0; i < 200 && !predicate(); i++) await delay(5);
	assert(predicate(), "Visibility transition did not settle");
}
async function setup(t: TestContext, options: {
	mode?: string; grant?: boolean; grantedTool?: string; first?: boolean; active?: boolean; allowlist?: boolean; direct?: boolean;
} = {}) {
	let api!: ExtensionAPI;
	let owner!: ReturnType<typeof createCodeModeDirectBinding>;
	let registration!: ReturnType<typeof registerCodeModeTools>;
	let nested!: CodeModeTool;
	const f = await piSession(t, {
		host: "/fixture-not-executed", grant: options.grant ?? true, visibility: options.mode ?? "hide-bridged",
		tools: options.grantedTool ?? "fixture__lookup", factoryFirst: options.first,
		activeTools: options.allowlist ? ["read", "lookup", "exec", "wait", "new_extra"] : undefined,
		factory: (pi) => {
			api = pi;
			pi.registerTool({ name: "lookup", label: "Lookup", description: "Direct fixture lookup", parameters: Type.Object({}),
				async execute() { return { content: [{ type: "text" as const, text: "direct" }], details: {} }; } });
			owner = createCodeModeDirectBinding(pi, { name: "lookup", sourcePath: "<inline:1>" });
			nested = { name: "lookup", description: "Nested fixture lookup", parameters: Type.Object({}), effect: "read",
				direct: options.direct === false ? undefined : owner.binding, async invoke() { return { value: "nested" }; } };
			registration = registerCodeModeTools(pi, { id: "fixture", tools: [nested] });
			pi.on("session_start", () => { owner.setActive(options.active ?? true); });
			pi.on("model_select", () => { owner.setActive(true); });
			pi.on("thinking_level_select", () => { owner.setActive(true); });
			pi.on("session_shutdown", () => { registration.dispose(); owner.dispose(); });
		},
	});
	return { ...f, get api() { return api; }, get owner() { return owner; }, get registration() { return registration; },
		get nested() { return nested; } };
}

for (const first of [false, true]) test(`real Pi: cooperative hiding/restoration works with owner ${first ? "before" : "after"} Code Mode`, async (t) => {
	const f = await setup(t, { first });
	assert(!f.session.getActiveToolNames().includes("lookup"));
	assert(f.session.getAllTools().some((tool) => tool.name === "lookup"), "hidden is not unregistered");
	assert(f.session.getActiveToolNames().includes("bash"), "unadapted direct tools stay active");
	assert(f.session.getActiveToolNames().includes("exec"));
	f.api.setActiveTools(f.api.getActiveTools().filter((name) => name !== "read"));
	await f.session.prompt("/code-mode visibility mixed");
	assert(f.session.getActiveToolNames().includes("lookup"));
	assert(!f.session.getActiveToolNames().includes("read"), "no whole-set restore");
	await f.session.prompt("/code-mode visibility hide-bridged");
	assert(!f.session.getActiveToolNames().includes("lookup"));
	await f.session.prompt("/code-mode off");
	assert(f.session.getActiveToolNames().includes("lookup"));
	assert(!f.session.getActiveToolNames().includes("exec"));
	assert.deepEqual(f.errors, []);
});

test("real Pi: mixed, missing authorization and missing owner cooperation never hide direct tools", async (t) => {
	for (const options of [{ mode: "mixed" }, { grant: false }, { grantedTool: "another__lookup" }, { direct: false }]) {
		await t.test(JSON.stringify(options), async (child) => {
			const f = await setup(child, options);
			assert(f.session.getActiveToolNames().includes("lookup"));
			assert(f.session.getActiveToolNames().includes("read"), "local tools.read is not Pi read ownership");
			if (options.grant === false) {
				await f.session.prompt("/code-mode visibility hide-bridged");
				assert(!f.session.getActiveToolNames().includes("exec"), "visibility cannot grant authority");
			}
		});
	}
});

test("real Pi: invalid visibility fails without enabling Code Mode", async (t) => {
	const f = await setup(t, { mode: "only" });
	assert(!f.session.getActiveToolNames().includes("exec"));
	assert(f.session.getActiveToolNames().includes("lookup"));
	assert(f.errors.some((error) => error.includes("strict only")));
});

test("real Pi: owner latest false intent and initially inactive state survive off", async (t) => {
	const f = await setup(t, { active: false });
	assert(!f.session.getActiveToolNames().includes("lookup"));
	await f.session.prompt("/code-mode visibility mixed");
	assert(!f.session.getActiveToolNames().includes("lookup"));
	f.owner.setActive(true);
	await f.session.prompt("/code-mode visibility hide-bridged");
	f.owner.setActive(false);
	await f.session.prompt("/code-mode off");
	assert(!f.session.getActiveToolNames().includes("lookup"));
});

test("real Pi: contribution refresh/disposal restores direct tools and preserves unrelated choices", async (t) => {
	const f = await setup(t);
	f.api.setActiveTools(f.api.getActiveTools().filter((name) => name !== "read"));
	f.registration.refresh([]);
	await until(() => f.session.getActiveToolNames().includes("lookup"));
	assert(!f.session.getActiveToolNames().includes("read"));
	f.registration.refresh([f.nested]);
	await until(() => !f.session.getActiveToolNames().includes("lookup"));
	f.registration.dispose();
	await until(() => f.session.getActiveToolNames().includes("lookup"));
	assert(!f.session.getAllTools().find((tool) => tool.name === "exec")?.description.includes("fixture__lookup"));
});

test("real Pi: dynamic registry/explicit allowlist reactivation is reconciled by the owner", async (t) => {
	const f = await setup(t, { allowlist: true });
	assert(!f.session.getActiveToolNames().includes("lookup"));
	f.api.registerTool({ name: "new_extra", label: "Extra", description: "New direct tool", parameters: Type.Object({}),
		async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; } });
	assert(f.session.getActiveToolNames().includes("lookup"), "verify Pi's real registry reactivation limitation");
	f.owner.reconcile();
	assert(!f.session.getActiveToolNames().includes("lookup"));
	assert(f.session.getActiveToolNames().includes("new_extra"));
	await f.session.prompt("/code-mode off");
	assert(f.session.getActiveToolNames().includes("lookup"));
	assert(f.session.getActiveToolNames().includes("new_extra"));
});

test("real Pi: model/thinking auto-enable cooperates; reload acquires fresh leases", async (t) => {
	const f = await setup(t);
	await f.session.setModel({ ...f.session.model!, id: "s4-thinking", reasoning: true });
	f.session.setThinkingLevel("low");
	await delay(0);
	assert(!f.session.getActiveToolNames().includes("lookup"));
	const old = f.owner;
	await f.session.reload();
	assert.notEqual(old, f.owner);
	assert.equal(old.setActive(true), false);
	assert(!f.session.getActiveToolNames().includes("lookup"));
	await f.session.prompt("/code-mode off");
	assert(f.session.getActiveToolNames().includes("lookup"));
	assert.deepEqual(f.errors, []);
});

test("real Pi: replacing a direct definition cannot restore or hide it via an old lease", async (t) => {
	const f = await setup(t);
	f.api.registerTool({ name: "lookup", label: "Replacement", description: "Replacement with different semantics", parameters: Type.Object({}),
		async execute() { return { content: [{ type: "text", text: "new" }], details: {} }; } });
	f.api.setActiveTools(f.api.getActiveTools().filter((name) => name !== "lookup"));
	await f.session.prompt("/code-mode off");
	assert(!f.session.getActiveToolNames().includes("lookup"), "old receipt must not enable new definition");
});

for (const first of [false, true]) test(`real Pi tree: current intent wins with owner first=${first}`, async (t) => {
	const f = await setup(t, { first, mode: "mixed" });
	const tools = f.session.getAllTools().map(({ name, description, parameters }) => ({
		name, description, parameters: structuredClone(parameters),
	}));
	const active = f.session.sessionManager.appendMessage({ role: "system", content: "", toolsAdded: tools, timestamp: Date.now() });
	const hidden = f.session.sessionManager.appendMessage({
		role: "system", content: "", toolsRemoved: [{ name: "lookup" }], timestamp: Date.now(),
	});
	f.owner.setActive(false);
	await f.session.navigateTree(active, { summarize: false });
	assert(!f.session.getActiveToolNames().includes("lookup"));
	f.owner.setActive(true);
	await f.session.navigateTree(hidden, { summarize: false });
	assert(f.session.getActiveToolNames().includes("lookup"));
	await f.session.prompt("/code-mode visibility hide-bridged");
	await f.session.navigateTree(active, { summarize: false });
	assert(!f.session.getActiveToolNames().includes("lookup"));
	await f.session.prompt("/code-mode off");
	await f.session.navigateTree(hidden, { summarize: false });
	assert(f.session.getActiveToolNames().includes("lookup"));
	assert.deepEqual(f.errors, []);
});
