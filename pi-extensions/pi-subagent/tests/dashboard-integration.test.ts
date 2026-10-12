import assert from "node:assert/strict";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { deferred, fixture, waitUntil } from "./support/fixture.ts";

test("dashboard observes live work without affecting it and retains own usage after unload/restart", async t => {
	const finish = deferred<string>();
	const f = await fixture(t, { reply: () => finish.promise });
	assert.deepEqual(f.coordinator.getSnapshot().agents, []);
	let notifications = 0;
	const unsubscribe = f.coordinator.subscribe(() => { notifications++; });
	const badObserver = f.coordinator.subscribe(() => { throw new Error("broken view"); });
	await f.coordinator.spawn(f.caller, {
		task_name: "review", message: "检查恢复逻辑\nInclude edge cases.", agent_type: "scout",
	});
	await waitUntil(() => f.requests.length === 1);
	const running = f.coordinator.getSnapshot();
	assert.equal(running.activeCount, 1);
	assert.equal(running.agents[0]?.path, "/root/review");
	assert.equal(running.agents[0]?.type, "scout");
	assert.equal(running.agents[0]?.topic, "检查恢复逻辑");
	assert.equal(running.agents[0]?.status, "running");
	assert.equal(running.agents[0]?.usage.requests, 0);
	assert.equal(typeof running.agents[0]?.activeSince, "number");
	assert(notifications > 0);
	unsubscribe();
	badObserver();
	const before = notifications;
	finish.resolve("Done");
	await f.idle();
	assert.equal(notifications, before);
	const completed = f.coordinator.getSnapshot().agents[0]!;
	assert.equal(completed.status, "completed");
	assert.equal(completed.usage.requests, 1);
	assert.equal(completed.usage.totalTokens, 2); // Not the inherited root's two tokens.
	assert.equal(completed.usage.cost, null); // Fixture has no meaningful price.
	assert.equal(completed.context?.live, false);
	assert.equal(completed.activeSince, undefined);
	assert.equal(typeof completed.durationMs, "number");
	assert.equal(completed.durationPartial, false);
	const old = f.coordinator;
	await f.restart();
	assert.equal(old.getSnapshot().closed, true);
	const restored = f.coordinator.getSnapshot().agents[0]!;
	assert.equal(restored.topic, completed.topic);
	assert.deepEqual(restored.usage, completed.usage);
	assert.equal(restored.durationMs, completed.durationMs);
	assert.equal(restored.context?.timestamp, completed.context?.timestamp);
	assert.equal(f.requests.length, 1);
});

test("dashboard topic advances on delivered follow-up, not queued mail", async t => {
	const finish = deferred<string>();
	const f = await fixture(t, { reply: (_context, request) => request === 1 ? finish.promise : "Follow-up done" });
	await f.coordinator.spawn(f.caller, { task_name: "worker", message: "First task" });
	await waitUntil(() => f.requests.length === 1);
	await f.coordinator.followup(f.caller, "worker", "Second task\nDetails");
	f.coordinator.send(f.caller, "worker", "This is context, not a task");
	assert.equal(f.coordinator.getSnapshot().agents[0]?.topic, "First task");
	finish.resolve("First done");
	await f.idle();
	assert.equal(f.coordinator.getSnapshot().agents[0]?.topic, "Second task");
	assert.equal(f.coordinator.getSnapshot().agents[0]?.usage.requests, 2);
	const duration = f.coordinator.getSnapshot().agents[0]!.durationMs!;
	await f.coordinator.followup(f.caller, "worker", "Third task");
	await f.idle();
	const agent = f.coordinator.getSnapshot().agents[0]!;
	assert.equal(agent.topic, "Third task");
	assert.equal(agent.usage.requests, 3);
	assert(agent.durationMs! >= duration);
	assert.equal(agent.durationPartial, false);
	assert.equal(f.requests.length, 3);
});

test("dashboard respects canonical visibility, missing transcripts, and no-session empty state", async t => {
	const f = await fixture(t);
	const anchor = f.manager.getLeafId()!;
	await f.coordinator.spawn(f.caller, { task_name: "visible", message: "work" });
	await f.idle();
	assert.equal(f.coordinator.getSnapshot().agents.length, 1);
	const file = f.coordinator.treeStore.record("/root/visible").sessionFile;
	renameSync(file, `${file}.unavailable`);
	const unavailable = f.coordinator.getSnapshot().agents[0]!;
	assert.equal(unavailable.path, "/root/visible");
	assert.equal(unavailable.usage.available, false);
	assert(unavailable.dataError);
	renameSync(`${file}.unavailable`, file);
	f.manager.branch(anchor);
	assert.deepEqual(f.coordinator.getSnapshot().agents, []);
	const transient = await fixture(t, { persistent: false });
	assert.deepEqual(transient.coordinator.getSnapshot().agents, []);
});

test("dashboard includes descendants once and orders parent before child", async t => {
	const f = await fixture(t);
	await f.coordinator.spawn(f.caller, { task_name: "parent", message: "Parent work" });
	await f.idle();
	const record = f.coordinator.treeStore.record("/root/parent");
	const parent = {
		...f.caller, path: "/root/parent", depth: 1,
		sessionManager: SessionManager.open(record.sessionFile),
	};
	await f.coordinator.spawn(parent, { task_name: "child", message: "Child work" });
	await f.idle();
	const agents = f.coordinator.getSnapshot().agents;
	assert.deepEqual(agents.map(agent => agent.path), ["/root/parent", "/root/parent/child"]);
	assert.equal(agents.reduce((sum, agent) => sum + agent.usage.totalTokens, 0), 4);
	assert.equal(agents.reduce((sum, agent) => sum + agent.usage.requests, 0), 2);
});

test("shutdown notifies and closes the old dashboard source without retaining observers", async t => {
	const f = await fixture(t);
	let closed = false;
	let notifications = 0;
	f.coordinator.subscribe(() => {
		notifications++;
		closed = f.coordinator.getSnapshot().closed === true;
	});
	await f.coordinator.shutdown();
	assert.equal(closed, true);
	assert.equal(notifications, 1);
	await f.coordinator.shutdown();
	assert.equal(notifications, 1);
});

test("reading empty, legacy or malformed cold transcripts never writes or repairs them", async t => {
	const f = await fixture(t);
	await f.coordinator.spawn(f.caller, { task_name: "worker", message: "work" });
	await f.idle();
	const file = f.coordinator.treeStore.record("/root/worker").sessionFile;
	const original = readFileSync(file, "utf8");
	try {
		for (const content of [
			"",
			'{"type":"session","version":1,"id":"legacy","timestamp":"2020-01-01","cwd":"/"}\n',
			`${original}{"broken":`,
		]) {
			writeFileSync(file, content);
			const agent = f.coordinator.getSnapshot().agents[0]!;
			assert(agent.dataError);
			assert.equal(agent.usage.available, false);
			assert.equal(readFileSync(file, "utf8"), content);
		}
	} finally { writeFileSync(file, original); }
});

test("broken timing metadata does not hide transcript usage or change the transcript", async t => {
	const f = await fixture(t);
	await f.coordinator.spawn(f.caller, { task_name: "worker", message: "work" });
	await f.idle();
	const file = f.coordinator.treeStore.record("/root/worker").sessionFile;
	const original = readFileSync(file, "utf8");
	writeFileSync(`${file}.telemetry.json`, "invalid metadata");
	const agent = f.coordinator.getSnapshot().agents[0]!;
	assert.equal(agent.usage.available, true);
	assert.equal(agent.usage.requests, 1);
	assert.equal(agent.usage.totalTokens, 2);
	assert.equal(agent.durationPartial, true);
	assert.match(agent.dataError!, /timing/i);
	assert.equal(readFileSync(file, "utf8"), original);
	assert.equal(readFileSync(`${file}.telemetry.json`, "utf8"), "invalid metadata");
});
