import assert from "node:assert/strict";
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
