import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { TREE_CUSTOM_TYPE } from "../src/store.ts";
import { INDEPENDENT_TREE_CONTEXT, independentTreeContext } from "../src/tree-context.ts";
import { deferred, fixture } from "./support/fixture.ts";
import { SubagentCoordinator } from "../src/coordinator.ts";

test("new-tree authority uses session identity/header, survives reload and does not accumulate history", async t => {
	const f = await fixture(t);
	assert.equal(independentTreeContext(f.manager), undefined);
	const copy = SessionManager.open(f.manager.getSessionFile()!);
	copy.createBranchedSession(copy.getLeafId()!);
	assert.notEqual(copy.getSessionId(), f.manager.getSessionId());
	assert.equal(independentTreeContext(copy), INDEPENDENT_TREE_CONTEXT);
	// Owning marker on a reload does not hide the copied ancestry.
	copy.appendCustomEntry(TREE_CUSTOM_TYPE, { rootSessionId: copy.getSessionId(), version: 1, id: "own" });
	assert.equal(independentTreeContext(copy), INDEPENDENT_TREE_CONTEXT);
	const count = copy.getEntries().length;
	for (let i = 0; i < 10; i++) assert.equal(independentTreeContext(copy), INDEPENDENT_TREE_CONTEXT);
	assert.equal(copy.getEntries().length, count);
	// A fork before the old marker is still independent via its header.
	const fresh = SessionManager.create(f.root, f.manager.getSessionDir());
	fresh.newSession({ parentSession: f.manager.getSessionFile()! });
	assert.equal(independentTreeContext(fresh), INDEPENDENT_TREE_CONTEXT);
});

test("independent-process branched session cannot own or stop the original active tree", async t => {
	const gate = deferred<string>();
	const f = await fixture(t, { reply: () => gate.promise });
	await f.coordinator.spawn(f.caller, { task_name: "worker", message: "wait", fork_turns: "none" });
	const originalTree = f.coordinator.treeStore.snapshot.id;
	const manager = SessionManager.open(f.manager.getSessionFile()!);
	manager.createBranchedSession(manager.getLeafId()!);
	const other = new SubagentCoordinator(f.pi, f.packageRoot, f.settings, f.agentDir);
	t.after(() => other.shutdown());
	const caller = other.attachRoot({ ...f.context, sessionManager: manager });
	assert.notEqual(other.treeStore.snapshot.id, originalTree);
	assert.deepEqual(other.list(caller).agents.map(agent => agent.agent_name), ["/root"]);
	assert.throws(() => other.send(caller, "/root/worker", "not your tree"), /unknown agent/);
	await other.shutdown();
	assert.equal(f.coordinator.activeCount, 1);
	assert.equal(f.coordinator.treeStore.record("/root/worker").status, "running");
	gate.resolve("original finished normally");
	await f.idle();
	assert.equal(f.coordinator.treeStore.record("/root/worker").status, "completed");
});
