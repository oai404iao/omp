import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createChildRuntime, resolveExecutionProfile, SelectionPersistenceError } from "../src/runtime.ts";
import { persistPreparedSession, prepareChildSession } from "../src/providers.ts";
import { DESCRIPTOR_VERSION, type AgentDescriptor } from "../src/types.ts";
import { fixture, stream, usage } from "./support/fixture.ts";

const spec = {
	id: "reasoner", name: "Reasoner", reasoning: true, input: ["text" as const],
	cost: usage.cost, contextWindow: 100000, maxTokens: 1000,
	thinkingLevelMap: { minimal: null, xhigh: "xhigh", max: null },
};

test("execution profiles preserve exact model resolution and normalize inherited thinking with Pi", async t => {
	const f = await fixture(t);
	f.modelRuntime.registerProvider("profiles", {
		api: "openai-responses", apiKey: "test", baseUrl: "http://scripted.invalid",
		models: [spec], streamSimple: (model, _context, opts) => stream(model, "done", opts?.signal),
	});
	const model = f.modelRuntime.getModel("profiles", "reasoner")!;
	assert.deepEqual(await resolveExecutionProfile(f.modelRuntime, model, "minimal"), { model, thinking: "low" });
	assert.deepEqual(await resolveExecutionProfile(f.modelRuntime, model, "max"), { model, thinking: "xhigh" });
	assert.equal((await resolveExecutionProfile(f.modelRuntime, f.model, "high")).thinking, "off");
	assert.deepEqual((await resolveExecutionProfile(f.modelRuntime, model, "off", { model: "reasoner", thinking: "xhigh" })).model, model);
	await assert.rejects(resolveExecutionProfile(f.modelRuntime, model, "off", { thinking: "minimal" }), /unsupported/);
	await assert.rejects(resolveExecutionProfile(f.modelRuntime, f.model, "off", { thinking: "high" }), /unsupported/);
	await assert.rejects(resolveExecutionProfile(f.modelRuntime, model, "off", { model: "profiles/missing" }), /unknown model/);
	await assert.rejects(resolveExecutionProfile(f.modelRuntime, undefined, "off"), /no parent model/);
});

test("bare model IDs retain same-provider preference and reject ambiguity otherwise", async t => {
	const f = await fixture(t);
	for (const provider of ["one", "two"]) {
		f.modelRuntime.registerProvider(provider, {
			api: "openai-responses", apiKey: "test", baseUrl: "http://scripted.invalid",
			models: [spec], streamSimple: (model, _context, opts) => stream(model, "done", opts?.signal),
		});
	}
	const parent = f.modelRuntime.getModel("one", "reasoner")!;
	assert.equal((await resolveExecutionProfile(f.modelRuntime, parent, "off", { model: "reasoner" })).model.provider, "one");
	await assert.rejects(resolveExecutionProfile(f.modelRuntime, f.model, "off", { model: "reasoner" }), /unknown or ambiguous/);
	assert.equal((await resolveExecutionProfile(f.modelRuntime, f.model, "off", { model: "two/reasoner" })).model.provider, "two");
});

test("catalog entries, stale callers, filtered models and configured-auth snapshots do not establish availability", async t => {
	const f = await fixture(t);
	const denied: Model<any> = { ...f.model, provider: "denied", id: "denied" };
	f.modelRuntime.registerNativeProvider({
		id: "denied", name: "Denied", getModels: () => [denied],
		auth: { apiKey: { name: "Test", check: async () => undefined, resolve: async () => undefined } },
		stream: (model, _context, opts) => stream(model, "done", opts?.signal),
		streamSimple: (model, _context, opts) => stream(model, "done", opts?.signal),
	});
	assert(f.modelRuntime.getModel("denied", "denied"));
	await assert.rejects(resolveExecutionProfile(f.modelRuntime, denied, "off"), /unavailable.*credentials/);
	f.modelRuntime.registerNativeProvider({
		id: "filtered", name: "Filtered", getModels: () => [{ ...denied, provider: "filtered" }],
		auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {}, source: "fixture" }) } },
		filterModels: () => [],
		stream: (model, _context, opts) => stream(model, "done", opts?.signal),
		streamSimple: (model, _context, opts) => stream(model, "done", opts?.signal),
	});
	await assert.rejects(resolveExecutionProfile(f.modelRuntime, denied, "off", { model: "filtered/denied" }), /unavailable/);
	await assert.rejects(resolveExecutionProfile(f.modelRuntime, { ...denied, provider: "removed" }, "off"), /unavailable/);
});

test("keyless virtual selection is retained without routing or assuming a physical model", async t => {
	const f = await fixture(t);
	let routes = 0;
	f.modelRuntime.registerVirtualModel({
		provider: "router", id: "auto", name: "Auto", thinkingLevels: ["low", "high"],
		route: () => { routes++; return { model: f.model, thinkingLevel: "off" }; },
	});
	const selected = f.modelRuntime.getModel("router", "auto")!;
	assert.deepEqual(await resolveExecutionProfile(f.modelRuntime, selected, "high"), { model: selected, thinking: "high" });
	await assert.rejects(resolveExecutionProfile(f.modelRuntime, selected, "high", { thinking: "off" }), /unsupported/);
	assert.equal(routes, 0);
});

test("invalid explicit model values reject before registering a child or changing parent history", async t => {
	const f = await fixture(t);
	const original = structuredClone(f.manager.getEntries());
	const originalAgents = f.coordinator.list(f.caller).agents;
	for (const value of ["", " ", "\t\n", null, false, 0, 17, {}, []]) {
		await assert.rejects(resolveExecutionProfile(f.modelRuntime, f.model, "high", { model: value as never }),
			/model must be a nonempty string/);
		await assert.rejects(f.coordinator.spawn(f.caller, {
			task_name: "invalid", message: "must not register", model: value as never,
		}), /model must be a nonempty string/);
		assert.deepEqual(f.manager.getEntries(), original);
		assert.deepEqual(f.coordinator.list(f.caller).agents, originalAgents);
		assert.equal(f.coordinator.activeCount, 0);
	}
	for (const value of ["", "unknown", null, false, 4, {}, []]) {
		await assert.rejects(resolveExecutionProfile(f.modelRuntime, f.model, "off", { thinking: value as never }),
			/unsupported/);
		await assert.rejects(f.coordinator.spawn(f.caller, {
			task_name: "invalid", message: "must not register", thinking: value as never,
		}), /unsupported/);
		assert.deepEqual(f.manager.getEntries(), original);
		assert.deepEqual(f.coordinator.list(f.caller).agents, originalAgents);
		assert.equal(f.coordinator.activeCount, 0);
	}
	assert.equal((await resolveExecutionProfile(f.modelRuntime, f.model, "high")).thinking, "off");
});

for (const method of ["appendModelChange", "appendThinkingLevelChange"] as const) {
	test(`SDK fresh selection ${method} failures are typed and restore public methods without running a model`, async t => {
		const f = await fixture(t);
		const manager = persistPreparedSession(prepareChildSession(f.manager, join(f.root, "child-sessions"), "none"));
		const failure = new Error(`SDK ${method} write failed`);
		const mocked = t.mock.method(manager, method, () => { throw failure; });
		const descriptor: AgentDescriptor = {
			version: DESCRIPTOR_VERSION, id: "child", path: "/root/child", parentPath: "/root", depth: 1,
			cwd: f.root, createdAt: new Date().toISOString(), agent: {
				name: "default", description: "", systemPrompt: "", source: "user",
			},
			model: { provider: f.model.provider, id: f.model.id }, thinkingLevel: "off",
			forkTurns: "none", settings: f.settings, anchorId: "",
		};
		await assert.rejects(createChildRuntime({
			descriptor, sessionManager: manager, parentSession: f.manager, modelRuntime: f.modelRuntime,
			agentDir: f.agentDir, packageRoot: f.packageRoot, projectTrusted: true, tools: [], hooks: () => {},
		}), error => error instanceof SelectionPersistenceError && error.cause === failure);
		assert.equal(manager[method], mocked);
		assert.equal(Object.hasOwn(manager, method === "appendModelChange" ? "appendThinkingLevelChange" : "appendModelChange"), false);
		assert.equal(f.requests.length, 0);
		assert.equal(SessionManager.open(manager.getSessionFile()!).getSessionId(), manager.getSessionId());
	});
}

test("session_start model selections remain live and persist rather than reverting to the descriptor", async t => {
	const f = await fixture(t, {
		settings: { inheritExtensions: true },
		extension: `export default pi => {
			pi.on("session_start", async (_event, ctx) => {
				const selected = ctx.modelRegistry.find("scripted", "other");
				if (selected) await pi.setModel(selected);
			});
		}`,
	});
	f.modelRuntime.registerProvider("scripted", {
		api: "openai-responses", apiKey: "test", baseUrl: "http://scripted.invalid",
		models: [{ ...spec, id: "echo" }, { ...spec, id: "other" }],
		streamSimple: (model, _context, opts) => stream(model, "done", opts?.signal),
	});
	await f.coordinator.spawn(f.caller, { task_name: "worker", message: "work", fork_turns: "none" });
	await f.idle();
	const record = f.coordinator.treeStore.record("/root/worker");
	assert.deepEqual(record.descriptor.model, { provider: "scripted", id: "other" });
	const changes = SessionManager.open(record.sessionFile).getBranch().filter(entry => entry.type === "model_change");
	assert.equal(changes.at(-1)?.modelId, "other");
});
