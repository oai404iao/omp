import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentCaller } from "../src/coordinator.ts";
import { MAX_PENDING_MESSAGES, MESSAGE_CUSTOM_TYPE } from "../src/store.ts";
import { fixture, stream, usage, waitUntil } from "./support/fixture.ts";

test("spawn profile inheritance is per-field and sticky followup does not track later caller changes", async t => {
	const f = await fixture(t);
	f.modelRuntime.registerProvider("profiles", {
		baseUrl: "http://scripted.invalid", apiKey: "test", api: "openai-responses",
		models: ["first", "second"].map(id => ({
			id, name: id, reasoning: true, input: ["text"] as ["text"],
			cost: usage.cost, contextWindow: 100000, maxTokens: 1000,
		})),
		streamSimple: (model, context, options) => {
			f.requests.push(structuredClone(context));
			return stream(model, "done", options?.signal);
		},
	});
	for (const [name, profile] of [
		["model_role", "model: profiles/second"], ["thinking_role", "thinking: high"],
	]) writeFileSync(join(f.agentDir, "agents", `${name}.md`),
		`---\nname: ${name}\ndescription: Test role\n${profile}\n---\nRole prompt.\n`);
	const caller: AgentCaller = {
		...f.caller, model: f.modelRuntime.getModel("profiles", "first"), thinkingLevel: "medium",
	};
	for (const [task_name, overrides, expected] of [
		["pure_caller", {}, { model: "profiles/first", thinking: "medium" }],
		["role_model", { agent_type: "model_role" }, { model: "profiles/second", thinking: "medium" }],
		["role_thinking", { agent_type: "thinking_role" }, { model: "profiles/first", thinking: "high" }],
		["explicit_thinking", { agent_type: "model_role", thinking: "low" }, { model: "profiles/second", thinking: "low" }],
		["explicit_model", { agent_type: "thinking_role", model: "scripted/echo" }, { model: "scripted/echo", thinking: "off" }],
	] as const) {
		assert.deepEqual(await f.coordinator.spawn(caller, { task_name, message: "task", ...overrides }),
			{ task_name: `/root/${task_name}`, ...expected });
		await f.idle();
	}
	caller.model = f.modelRuntime.getModel("profiles", "second");
	caller.thinkingLevel = "off";
	assert.deepEqual(await f.coordinator.followup(caller, "pure_caller", "preserve original pair"),
		{ accepted: true, model: "profiles/first", thinking: "medium" });
	await f.idle();
	assert.deepEqual(f.coordinator.treeStore.record("/root/pure_caller").descriptor.model, { provider: "profiles", id: "first" });
});

test("nested spawning inherits the current SDK model and thinking after an extension switches them", async t => {
	const f = await fixture(t, {
		settings: { inheritExtensions: true },
		extension: `export default function(pi) {
			pi.on("before_agent_start", async (_event, ctx) => {
				const descriptor = ctx.sessionManager.getBranch().find(e => e.type === "custom" && e.customType === "pi-subagent/descriptor");
				if (descriptor?.data.path !== "/root/parent") return;
				await pi.setModel(ctx.modelRegistry.find("profiles", "changed"));
				pi.setThinkingLevel("high");
			});
		}`,
	});
	let requests = 0;
	f.modelRuntime.registerProvider("profiles", {
		baseUrl: "http://scripted.invalid", apiKey: "test", api: "openai-responses",
		models: [{
			id: "changed", name: "Changed", reasoning: true, input: ["text"],
			cost: usage.cost, contextWindow: 100000, maxTokens: 1000,
		}],
		streamSimple: (model, context, options) => {
			f.requests.push(structuredClone(context));
			return stream(model, ++requests === 1 ? [{
				type: "toolCall", id: "nested", name: "spawn_agent",
				arguments: { task_name: "child", message: "inherit switched pair", fork_turns: "none" },
			}] : "done", options?.signal);
		},
	});
	await f.coordinator.spawn(f.caller, { task_name: "parent", message: "delegate", fork_turns: "none" });
	await f.idle();
	const child = f.coordinator.treeStore.record("/root/parent/child");
	assert.deepEqual(child.descriptor.model, { provider: "profiles", id: "changed" });
	assert.equal(child.descriptor.thinkingLevel, "high");
	assert.equal(child.descriptor.parentPath, "/root/parent");
	assert.deepEqual(f.coordinator.treeStore.record("/root/parent").descriptor.model, child.descriptor.model);
});

test("list reports latest physical response before a tool-waiting run settles", async t => {
	const f = await fixture(t, { reply: (_ctx, request) => request === 1 ? [{
		type: "toolCall", id: "wait", name: "wait_agent", arguments: { timeout_ms: 300000 },
	}] : "finished" });
	await f.coordinator.spawn(f.caller, { task_name: "worker", message: "wait on inbox" });
	await waitUntil(() => f.requests.length === 1 &&
		!!f.coordinator.list(f.caller, "worker").agents[0]?.last_response);
	assert.equal(f.coordinator.treeStore.record("/root/worker").status, "running");
	assert.equal(f.coordinator.treeStore.record("/root/worker").lastResponse, undefined);
	assert.deepEqual(f.coordinator.list(f.caller, "worker").agents[0]?.last_response,
		{ model: "scripted/echo", thinking: "off" });
	f.coordinator.send(f.caller, "worker", "wake up");
	await f.idle();
});

test("existing completion outboxes to a closed parent remain durable and drain only as audit mail", async t => {
	const f = await fixture(t);
	await f.coordinator.spawn(f.caller, { task_name: "parent", message: "initial parent" });
	await f.idle();
	const parent = f.coordinator.treeStore.record("/root/parent");
	const caller: AgentCaller = {
		...f.caller, path: "/root/parent", depth: 1, sessionManager: SessionManager.open(parent.sessionFile),
	};
	for (let n = 0; n < MAX_PENDING_MESSAGES; n++) f.coordinator.send(f.caller, "parent", `full ${n}`);
	await f.coordinator.spawn(caller, { task_name: "child", message: "child completion" });
	await f.idle();
	const childPath = "/root/parent/child";
	const outbox = structuredClone(f.coordinator.treeStore.record(childPath).outbox);
	assert.equal(outbox?.length, 1);
	f.coordinator.close(f.caller, "parent");
	assert.deepEqual(f.coordinator.treeStore.record(childPath).outbox, outbox);
	const requests = f.requests.length;
	f.coordinator.treeStore.acknowledge("/root/parent",
		new Set(f.coordinator.treeStore.mailbox("/root/parent").map(message => message.id)));
	const envelope = f.coordinator.inboxMessage("/root", f.manager)!;
	f.manager.appendCustomMessageEntry(MESSAGE_CUSTOM_TYPE, envelope.content, true, envelope.details);
	f.coordinator.reconcile("/root", f.manager);
	assert.equal(f.coordinator.treeStore.record(childPath).outbox?.length, 0);
	assert.equal(f.coordinator.treeStore.mailbox("/root/parent")[0]?.text, "answer 2");
	assert.equal(f.coordinator.inboxMessage("/root/parent", SessionManager.open(parent.sessionFile)), undefined);
	assert.equal(f.requests.length, requests);
	assert.equal(f.coordinator.activeCount, 0);
});
