import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices,
	type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";
import { MESSAGE_CUSTOM_TYPE, TREE_CUSTOM_TYPE } from "../src/store.ts";
import { fixture } from "./support/fixture.ts";
import { INDEPENDENT_TREE_CONTEXT } from "../src/tree-context.ts";

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
	const rootId = runtime.session.sessionId;
	const originalTree = entries.find(entry => entry.type === "custom" && entry.customType === TREE_CUSTOM_TYPE);
	listMode = true;
	const forkAt = runtime.session.sessionManager.getLeafId()!;
	assert.equal((await runtime.fork(forkAt, { position: "at" })).cancelled, false);
	assert.notEqual(runtime.session.sessionId, rootId, "/clone's fork(at) path creates a new root identity");
	await runtime.session.prompt("list only");
	assert.match(JSON.stringify(f.requests.at(-1)), new RegExp(INDEPENDENT_TREE_CONTEXT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
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
	assert.equal(runtime.session.sessionId, rootId);
	const canonicalLeaf = runtime.session.sessionManager.getLeafId()!;
	const beforeRegistration = entries.find(entry => entry.type === "custom" && entry.customType === TREE_CUSTOM_TYPE)!;
	listed = false;
	assert.equal((await runtime.session.navigateTree(beforeRegistration.id, { summarize: false })).cancelled, false);
	const count = f.requests.length;
	await runtime.session.prompt("list earlier branch");
	assert.equal(f.requests.length, count + 2, "tree navigation does not replay child work");
	const hidden = runtime.session.sessionManager.getEntries().filter(entry =>
		entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "list_agents").at(-1)!;
	assert.doesNotMatch(JSON.stringify((hidden as any).message.details.agents), /root\/worker/);
	listed = false;
	await runtime.session.navigateTree(canonicalLeaf, { summarize: false });
	await runtime.session.prompt("list restored branch");
	const visible = runtime.session.sessionManager.getEntries().filter(entry =>
		entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "list_agents").at(-1)!;
	assert.match(JSON.stringify((visible as any).message.details.agents), /root\/worker/);
	// Real /fork path is before a user message, unlike /clone's position:at.
	const user = runtime.session.getUserMessagesForForking().at(-1)!;
	listed = false;
	assert.equal((await runtime.fork(user.entryId)).cancelled, false);
	await runtime.session.prompt("list forked branch");
	const forkedList = runtime.session.sessionManager.getEntries().filter(entry =>
		entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "list_agents").at(-1)!;
	assert.deepEqual((forkedList as any).message.details.agents.map((agent: any) => agent.agent_name), ["/root"]);
	const forkId = runtime.session.sessionId;
	await runtime.session.reload();
	assert.equal(runtime.session.sessionId, forkId);
	for (let i = 0; i < 2; i++) {
		listed = false;
		await runtime.session.prompt("list after reload");
		assert.match(JSON.stringify(f.requests.at(-1)), /This is a new independent agent tree/);
		const sections = runtime.session.sessionManager.getEntries().flatMap(entry =>
			entry.type === "message" && entry.message.role === "system" &&
			entry.message.sections?.subagent_tree ? [entry.message.sections.subagent_tree] : []);
		assert(sections.length > 0);
		assert(sections.every(section => section.split(INDEPENDENT_TREE_CONTEXT).length - 1 === 1),
			"each authoritative section contains exactly one notice, including across reload");
		await runtime.session.reload();
	}
});
