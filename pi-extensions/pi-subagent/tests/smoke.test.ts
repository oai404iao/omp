import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices,
	type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";
import { MESSAGE_CUSTOM_TYPE, TREE_CUSTOM_TYPE } from "../src/store.ts";
import { fixture } from "./support/fixture.ts";

test("real root SDK delivers wait messages as context, forks into a fresh tree, and reloads", async t => {
	let listMode = false;
	let listed = false;
	const f = await fixture(t, { reply: context => {
		const text = JSON.stringify(context.messages);
		if (text.includes("You are agent /root/worker.")) return "worker final result";
		if (listMode) {
			if (listed) return "listed agents";
			listed = true;
			return [{ type: "toolCall", id: "list", name: "list_agents", arguments: {} }];
		}
		if (text.includes("[Agent completion: /root/worker")) return "root integrated result";
		if (context.messages.some(message => message.role === "toolResult" && message.toolName === "spawn_agent")) {
			return [{ type: "toolCall", id: "wait", name: "wait_agent", arguments: {} }];
		}
		return [{ type: "toolCall", id: "spawn", name: "spawn_agent",
			arguments: { task_name: "worker", message: "do work", fork_turns: "none" } }];
	} });
	// This test uses the actual extension loader, not the fixture controller.
	await f.coordinator.shutdown();
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = f.agentDir;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	});
	const create: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd, agentDir: f.agentDir, modelRuntime: f.modelRuntime,
			resourceLoaderOptions: { noExtensions: true, extensionFactories: [{ name: "subagent", factory: extension }] },
		});
		return {
			...await createAgentSessionFromServices({
				services, sessionManager, sessionStartEvent, model: f.model, thinkingLevel: "off",
			}), services, diagnostics: services.diagnostics,
		};
	};
	const runtime = await createAgentSessionRuntime(create, { cwd: f.root, agentDir: f.agentDir, sessionManager: f.manager });
	t.after(async () => { await runtime.dispose(); });
	runtime.setRebindSession(session => session.bindExtensions({ mode: "print" }));
	await runtime.session.bindExtensions({ mode: "print" });
	await runtime.session.prompt("delegate the task");
	assert.equal(runtime.session.getLastAssistantText(), "root integrated result");
	const entries = runtime.session.sessionManager.getEntries();
	assert(entries.some(entry => entry.type === "custom_message" && entry.customType === MESSAGE_CUSTOM_TYPE));
	const waitResult = entries.find(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "wait_agent");
	assert.ok(waitResult);
	assert.doesNotMatch(JSON.stringify(waitResult), /worker final result/);
	const rootFile = runtime.session.sessionFile!;
	const originalTree = entries.find(entry => entry.type === "custom" && entry.customType === TREE_CUSTOM_TYPE);
	listMode = true;
	const forkAt = runtime.session.sessionManager.getLeafId()!;
	assert.equal((await runtime.fork(forkAt, { position: "at" })).cancelled, false);
	await runtime.session.prompt("list only");
	const forkEntries = runtime.session.sessionManager.getEntries();
	const trees = forkEntries.filter(entry => entry.type === "custom" && entry.customType === TREE_CUSTOM_TYPE);
	assert.notDeepEqual(trees.at(-1), originalTree);
	const listedResult = forkEntries.filter(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "list_agents").at(-1)!;
	assert.equal(listedResult.type, "message");
	if (listedResult.type === "message" && listedResult.message.role === "toolResult") {
		assert.deepEqual((listedResult.message.details as any).agents.map((agent: any) => agent.agent_name), ["/root"]);
	}
	listed = false;
	assert.equal((await runtime.switchSession(rootFile)).cancelled, false);
	await runtime.session.prompt("list only");
	const restored = runtime.session.sessionManager.getEntries().filter(entry =>
		entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "list_agents").at(-1)!;
	assert.match(JSON.stringify(restored), /root\/worker/);
});
