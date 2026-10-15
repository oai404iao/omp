import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentCaller } from "../src/coordinator.ts";
import { MESSAGE_CUSTOM_TYPE } from "../src/store.ts";
import { assistant, deferred, fixture } from "./support/fixture.ts";

test("fresh SDK selection write failure rejects an unaccepted spawn without reserving its identity", async t => {
	const f = await fixture(t);
	const append = SessionManager.prototype.appendModelChange;
	let failed = false;
	t.mock.method(SessionManager.prototype, "appendModelChange", function (this: SessionManager, provider: string, modelId: string) {
		const id = append.call(this, provider, modelId);
		if (!failed) { failed = true; throw new Error("simulated initial selection write failure"); }
		return id;
	});
	await assert.rejects(f.coordinator.spawn(f.caller, { task_name: "worker", message: "unaccepted" }), /persist child execution profile/);
	assert.equal(f.coordinator.treeStore.snapshot.agents["/root/worker"], undefined);
	assert.equal(f.coordinator.activeCount, 0);
	assert.equal(f.requests.length, 0);
	await f.coordinator.spawn(f.caller, { task_name: "worker", message: "retry accepted" });
	await f.idle();
	assert.equal(f.requests.length, 1);
});

test("selection failure during initialization preserves independently accepted mail", async t => {
	const reached = deferred();
	const resume = deferred();
	(globalThis as any).__subagent_selection_failure_gate = { reached, resume };
	t.after(() => { delete (globalThis as any).__subagent_selection_failure_gate; });
	const f = await fixture(t, {
		settings: { inheritExtensions: true },
		extension: `export default function(pi) {
			pi.on("session_start", async (_event, ctx) => {
				globalThis.__subagent_selection_failure_gate.reached.resolve();
				await globalThis.__subagent_selection_failure_gate.resume.promise;
				ctx.sessionManager.appendThinkingLevelChange("low");
			});
		}`,
	});
	const append = SessionManager.prototype.appendThinkingLevelChange;
	let inject = false;
	let failed = false;
	t.mock.method(SessionManager.prototype, "appendThinkingLevelChange", function (
		this: SessionManager, level: Parameters<SessionManager["appendThinkingLevelChange"]>[0],
	) {
		const id = append.call(this, level);
		if (inject && level === "off" && !failed) { failed = true; throw new Error("simulated mirror failure"); }
		return id;
	});
	const spawn = f.coordinator.spawn(f.caller, { task_name: "worker", message: "unaccepted initial task" });
	const rejected = assert.rejects(spawn, /persist child execution profile/);
	await reached.promise;
	f.coordinator.send(f.caller, "worker", "independently accepted context");
	inject = true;
	resume.resolve();
	await rejected;
	const record = f.coordinator.treeStore.record("/root/worker");
	assert.equal(record.lifecycle, "open");
	assert.equal(record.status, "errored");
	assert.deepEqual(record.mailbox.map(message => message.text), ["independently accepted context"]);
	assert.equal(f.requests.length, 0);
	await f.coordinator.followup(f.caller, "worker", "resume retained identity");
	await f.idle();
	assert.match(JSON.stringify(f.requests[0]), /independently accepted context/);
	assert.doesNotMatch(JSON.stringify(f.requests[0]), /unaccepted initial task/);
});

test("close racing a durable task receipt retains cancellation audit rather than ACK-deleting it", async t => {
	const f = await fixture(t);
	await f.coordinator.spawn(f.caller, { task_name: "worker", message: "initial" });
	await f.idle();
	const record = f.coordinator.treeStore.record("/root/worker");
	const manager = SessionManager.open(record.sessionFile);
	f.coordinator.treeStore.enqueue({
		id: "receipt-race", from: "/root", to: "/root/worker", kind: "task", text: "queued task", createdAt: "now",
	});
	const envelope = f.coordinator.inboxMessage("/root/worker", manager)!;
	manager.appendCustomMessageEntry(MESSAGE_CUSTOM_TYPE, envelope.content, true, envelope.details);
	f.coordinator.close(f.caller, "worker");
	f.coordinator.reconcile("/root/worker", manager);
	const task = f.coordinator.treeStore.record("/root/worker").mailbox.find(message => message.id === "receipt-race");
	assert(task?.canceledAt);
	assert.equal(task?.canceledBy, "/root");
	await f.restart();
	assert(f.coordinator.treeStore.record("/root/worker").mailbox.find(message => message.id === "receipt-race")?.canceledAt);
});

test("cold list reads latest canonical physical response even if crash left cached metadata stale", async t => {
	const f = await fixture(t);
	await f.coordinator.spawn(f.caller, { task_name: "worker", message: "initial" });
	await f.idle();
	const record = f.coordinator.treeStore.record("/root/worker");
	const manager = SessionManager.open(record.sessionFile);
	manager.appendMessage({ ...assistant("recorded before crash", "toolUse"), provider: "physical", model: "routed", thinkingLevel: "low" });
	// Simulate a crash snapshot before settlement: transcript contains the actual
	// response, while the cached store metadata still describes the previous run.
	f.coordinator.treeStore.update(state => { state.agents["/root/worker"]!.status = "running"; });
	await f.restart();
	const listed = f.coordinator.list(f.caller, "worker").agents[0]!;
	assert.deepEqual(listed.last_response, { model: "physical/routed", thinking: "low" });
	assert.equal(listed.model, "scripted/echo");
	assert.equal(listed.agent_status, "interrupted");
	assert.equal(f.requests.length, 1);
});

test("listing empty or old cold transcripts never initializes or migrates their files", async t => {
	const f = await fixture(t);
	await f.coordinator.spawn(f.caller, { task_name: "parent", message: "parent" });
	await f.idle();
	const parent = f.coordinator.treeStore.record("/root/parent");
	const caller: AgentCaller = {
		...f.caller, path: "/root/parent", depth: 1, sessionManager: SessionManager.open(parent.sessionFile),
	};
	await f.coordinator.spawn(caller, { task_name: "child", message: "child" });
	await f.idle();
	const original = readFileSync(parent.sessionFile, "utf8");
	const lines = original.trimEnd().split("\n");
	const old = [JSON.stringify({ ...JSON.parse(lines[0]!), version: 1 }), ...lines.slice(1)].join("\n") + "\n";
	const state = readFileSync(`${f.coordinator.treeStore.directory}/state.json`, "utf8");
	const childFile = f.coordinator.treeStore.record("/root/parent/child").sessionFile;
	const childBefore = readFileSync(childFile, "utf8");
	for (const content of ["", old]) {
		writeFileSync(parent.sessionFile, content);
		const listed = f.coordinator.list(f.caller, undefined, { include_closed: true });
		assert(listed.agents.some(agent => agent.agent_name === "/root/parent"));
		assert(!listed.agents.some(agent => agent.agent_name === "/root/parent/child"));
		assert.equal(readFileSync(parent.sessionFile, "utf8"), content);
		assert.equal(readFileSync(childFile, "utf8"), childBefore);
		assert.equal(readFileSync(`${f.coordinator.treeStore.directory}/state.json`, "utf8"), state);
	}
	assert.equal(f.requests.length, 2);
	assert.equal(f.coordinator.activeCount, 0);
});
