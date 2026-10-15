import assert from "node:assert/strict";
import { getCurrentSystemPrompt, type Context } from "@earendil-works/pi-ai";
import { test, type TestContext } from "node:test";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	FAST_MODE_CUSTOM_TYPE, installFastModeLifecycle, sessionFastMode, setSessionFastMode,
} from "../../pi-codex-runtime/src/fast-mode-state.ts";
import type { AgentCaller } from "../src/coordinator.ts";
import { deferred, fixture, stream, usage, waitUntil } from "./support/fixture.ts";

function rootFastMode(t: TestContext, manager: SessionManager) {
	const handlers = new Map<string, (...args: any[]) => unknown>();
	const pi = {
		on: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler),
		appendEntry: (type: string, data: unknown) => manager.appendCustomEntry(type, data),
	} as unknown as ExtensionAPI;
	installFastModeLifecycle(pi);
	handlers.get("session_start")!({}, { sessionManager: manager });
	t.after(() => { handlers.get("session_shutdown")!(); });
	return (enabled: boolean) => setSessionFastMode(pi, manager, enabled);
}

for (const nonResponses of [false, true]) {
	test(`Fast follows the main session with ${nonResponses ? "a non-Responses model" : "wire identity disabled"}`, async t => {
		const finish = deferred<string>();
		const observed: boolean[] = [];
		const f = await fixture(t, {
			settings: { openAIIdentity: nonResponses, inheritExtensions: false },
			modelApi: nonResponses ? "anthropic-messages" : "openai-responses",
			reply: (_context, request) => {
				const child = SessionManager.open(f.coordinator.treeStore.record("/root/worker").sessionFile);
				observed.push(sessionFastMode(child.getSessionId(), false));
				return request === 1 ? finish.promise : "done";
			},
		});
		const setFast = rootFastMode(t, f.manager);
		setFast(true);
		await f.coordinator.spawn(f.caller, { task_name: "worker", message: "work", fork_turns: "none" });
		await waitUntil(() => observed.length === 1);
		assert.deepEqual(observed, [true]);
		setFast(false);
		await f.coordinator.followup(f.caller, "worker", "next request");
		finish.resolve("first request complete");
		await f.idle();
		assert.deepEqual(observed, [true, false]);
		setFast(true);
		await f.coordinator.followup(f.caller, "worker", "cold resume");
		await f.idle();
		assert.deepEqual(observed, [true, false, true]);
		const child = SessionManager.open(f.coordinator.treeStore.record("/root/worker").sessionFile);
		assert(child.getEntries().some(entry => entry.type === "custom" && entry.customType === FAST_MODE_CUSTOM_TYPE));
		assert(!child.getEntries().some(entry => entry.type === "custom" && entry.customType.includes("identity")));
	});
}

test("a Responses grandchild follows main Fast through an unloaded non-Responses parent", async t => {
	const observed: boolean[] = [];
	const f = await fixture(t, {
		settings: { openAIIdentity: true },
		modelApi: "anthropic-messages",
		reply: () => {
			const child = SessionManager.open(f.coordinator.treeStore.record("/root/worker").sessionFile);
			observed.push(sessionFastMode(child.getSessionId(), false));
			return "done";
		},
	});
	const setFast = rootFastMode(t, f.manager);
	setFast(true);
	await f.coordinator.spawn(f.caller, { task_name: "worker", message: "work", fork_turns: "none" });
	await f.idle();
	const parent = SessionManager.open(f.coordinator.treeStore.record("/root/worker").sessionFile);
	assert(!parent.getEntries().some(entry => entry.type === "custom" && entry.customType.includes("identity")));
	f.modelRuntime.registerProvider("responses", {
		baseUrl: "http://scripted.invalid", apiKey: "test", api: "openai-responses",
		models: [{ id: "echo", name: "Echo", reasoning: false, input: ["text"],
			cost: usage.cost, contextWindow: 100000, maxTokens: 1000 }],
		streamSimple: (model, _context, options) => {
			observed.push(sessionFastMode(options?.sessionId, false));
			return stream(model, "done", options?.signal);
		},
	});
	const caller: AgentCaller = {
		...f.caller, path: "/root/worker", depth: 1, sessionManager: parent,
		model: f.modelRuntime.getModel("responses", "echo"),
	};
	setFast(false);
	await f.coordinator.spawn(caller, { task_name: "nested", message: "nested work", fork_turns: "none" });
	await f.idle();
	assert.deepEqual(observed, [true, false]);
	setFast(true);
	await f.coordinator.followup(f.caller, "/root/worker/nested", "continue");
	await f.idle();
	assert.deepEqual(observed, [true, false, true]);
	const child = SessionManager.open(f.coordinator.treeStore.record("/root/worker/nested").sessionFile);
	const saved = child.getEntries().find(entry => entry.type === "custom" && entry.customType === FAST_MODE_CUSTOM_TYPE);
	assert.equal(saved?.type, "custom");
	if (saved?.type === "custom") assert.equal((saved.data as any).rootSessionId, f.manager.getSessionId());
});

test("virtual selections survive physical responses and profile switches keep history, context and root Fast", async t => {
	const observations: Array<{ prompt: string; fast: boolean; context: Context }> = [];
	const f = await fixture(t, {
		settings: { openAIIdentity: true, inheritExtensions: false },
		reply: context => {
			const child = SessionManager.open(f.coordinator.treeStore.record("/root/worker").sessionFile);
			observations.push({
				prompt: getCurrentSystemPrompt(context.messages), fast: sessionFastMode(child.getSessionId(), false),
				context: structuredClone(context),
			});
			return `physical answer ${observations.length}`;
		},
	});
	const routes: string[] = [];
	f.modelRuntime.registerVirtualModel({
		provider: "router", id: "auto", name: "Auto", thinkingLevels: ["low", "high"],
		route: request => {
			routes.push(request.thinkingLevel);
			return { model: f.model, thinkingLevel: "off" };
		},
	});
	const selected = f.modelRuntime.getModel("router", "auto")!;
	const caller: AgentCaller = { ...f.caller, model: selected, thinkingLevel: "high" };
	const setFast = rootFastMode(t, f.manager);
	setFast(true);
	await f.coordinator.spawn(caller, { task_name: "worker", message: "中文任务", fork_turns: "none" });
	await f.idle();
	const first = f.coordinator.treeStore.record("/root/worker");
	const sessionFile = first.sessionFile;
	const sessionId = SessionManager.open(sessionFile).getSessionId();
	assert.deepEqual(first.descriptor.model, { provider: "router", id: "auto" });
	assert.equal(first.descriptor.thinkingLevel, "high");
	assert.match(observations[0]!.prompt, /You are agent \/root\/worker\. Your parent is \/root\./);
	assert.match(observations[0]!.prompt, /Selected model: router\/auto\. Thinking level: high\./);
	setFast(false);
	await f.coordinator.followup(f.caller, "worker", "switch to physical", undefined, { model: "scripted/echo" });
	await f.idle();
	assert.match(observations[1]!.prompt, /Selected model: scripted\/echo\. Thinking level: off\./);
	assert.match(JSON.stringify(observations[1]!.context.messages), /中文任务.*physical answer 1/);
	setFast(true);
	await f.coordinator.followup(f.caller, "worker", "switch back", undefined, { model: "router/auto", thinking: "high" });
	await f.idle();
	assert.match(observations[2]!.prompt, /Selected model: router\/auto\. Thinking level: high\./);
	assert.deepEqual(observations.map(value => value.fast), [true, false, true]);
	assert.deepEqual(routes, ["high", "high"]);
	const record = f.coordinator.treeStore.record("/root/worker");
	assert.equal(record.sessionFile, sessionFile);
	const child = SessionManager.open(sessionFile);
	assert.equal(child.getSessionId(), sessionId);
	assert.deepEqual(child.getBranch().filter(entry => entry.type === "model_change")
		.map(entry => `${entry.provider}/${entry.modelId}`), ["router/auto", "scripted/echo", "router/auto"]);
	const responses = child.getBranch().filter(entry => entry.type === "message" && entry.message.role === "assistant");
	assert.equal(responses.length, 3);
	for (const entry of responses) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		assert.equal(entry.message.provider, "scripted");
		assert.equal(entry.message.model, "echo");
		assert.equal(entry.message.thinkingLevel, "off");
	}
	assert.deepEqual(record.descriptor.model, { provider: "router", id: "auto" });
	assert.equal(record.descriptor.thinkingLevel, "high");
	assert.equal(caller.model, selected);
	assert.equal(caller.thinkingLevel, "high");
});
