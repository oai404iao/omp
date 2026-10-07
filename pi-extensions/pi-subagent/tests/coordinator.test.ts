import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { MESSAGE_CUSTOM_TYPE, MAX_PENDING_MESSAGES, TreeStore } from "../src/store.ts";
import type { AgentCaller } from "../src/coordinator.ts";
import { createAgentTools } from "../src/tools.ts";
import { deferred, fixture, waitUntil } from "./support/fixture.ts";

test("spawn accepts before completion, persists identity and final result, unloads runtime", async t => {
	const finish = deferred<string>();
	const f = await fixture(t, { reply: () => finish.promise });
	assert.deepEqual(await f.coordinator.spawn(f.caller, { task_name: "review", message: "Review it" }), { task_name: "/root/review" });
	const record = f.coordinator.treeStore.record("/root/review");
	assert(existsSync(record.sessionFile));
	assert.equal(record.status, "running");
	assert.equal(f.coordinator.activeCount, 1);
	assert.equal(f.coordinator.treeStore.mailbox("/root").length, 0);
	finish.resolve("review complete");
	await f.idle();
	assert.equal(f.coordinator.treeStore.record("/root/review").status, "completed");
	assert.equal(f.coordinator.treeStore.mailbox("/root")[0]?.text, "review complete");
	assert(f.coordinator.list(f.caller).agents.some(agent => agent.agent_name === "/root/review"));
	assert.equal(f.manager.getEntries().filter(entry => entry.type === "usage").length, 1);
});

test("send to idle child is queue-only; followup carries task and cold resumes same session", async t => {
	const f = await fixture(t);
	await f.coordinator.spawn(f.caller, { task_name: "worker", message: "Initial work", fork_turns: "none" });
	await f.idle();
	const file = f.coordinator.treeStore.record("/root/worker").sessionFile;
	assert.deepEqual(f.coordinator.send(f.caller, "worker", "extra context"), { accepted: true });
	assert.equal(f.requests.length, 1);
	assert.equal(f.coordinator.activeCount, 0);
	await f.coordinator.followup(f.caller, "worker", "Now continue");
	await f.idle();
	assert.equal(f.coordinator.treeStore.record("/root/worker").sessionFile, file);
	assert.equal(f.requests.length, 2);
	assert.match(JSON.stringify(f.requests[1]), /extra context/);
	assert.match(JSON.stringify(f.requests[1]), /Now continue/);
	assert.match(JSON.stringify(f.requests[1]), /Initial work/);
	assert.equal(f.coordinator.treeStore.mailbox("/root/worker").length, 0);
});

test("running messages and tasks enter a safe boundary without parallel model runs", async t => {
	const finish = deferred<string>();
	const f = await fixture(t, { reply: (_ctx, n) => n === 1 ? finish.promise : "handled updates" });
	await f.coordinator.spawn(f.caller, { task_name: "worker", message: "start" });
	await waitUntil(() => f.requests.length === 1);
	f.coordinator.send(f.caller, "worker", "mail while sampling");
	await f.coordinator.followup(f.caller, "worker", "task while sampling");
	assert.equal(f.requests.length, 1);
	finish.resolve("first answer");
	await f.idle();
	assert.equal(f.requests.length, 2);
	assert.match(JSON.stringify(f.requests[1]), /mail while sampling/);
	assert.match(JSON.stringify(f.requests[1]), /task while sampling/);
	assert.equal(f.events.filter(event => event.name === "pi-subagent:turn-start").length, 1);
	assert.equal(f.coordinator.treeStore.mailbox("/root").length, 1);
});

test("wait is activity-only, does not consume content, and context receipts acknowledge", async t => {
	const f = await fixture(t);
	await f.coordinator.spawn(f.caller, { task_name: "worker", message: "start" });
	await f.idle();
	const before = f.coordinator.treeStore.mailbox("/root");
	const result = await f.coordinator.wait(f.caller);
	assert.equal(result.timed_out, false);
	assert.doesNotMatch(JSON.stringify(result), /answer 1|completion:/);
	assert.deepEqual(f.coordinator.treeStore.mailbox("/root"), before);
	const message = f.coordinator.inboxMessage("/root", f.manager)!;
	f.manager.appendCustomMessageEntry(message.customType, message.content, true, message.details);
	f.coordinator.reconcile("/root", f.manager);
	assert.equal(f.coordinator.treeStore.mailbox("/root").length, 0);
});

test("wait wakes on new messages and steered input, aborts cleanly", async t => {
	const f = await fixture(t);
	const waiting = f.coordinator.wait(f.caller, 300_000);
	f.coordinator.send(f.caller, "/root", "hello");
	assert.equal((await waiting).timed_out, false);
	const envelope = f.coordinator.inboxMessage("/root", f.manager)!;
	f.manager.appendCustomMessageEntry(envelope.customType, envelope.content, true, envelope.details);
	f.coordinator.reconcile("/root", f.manager);
	const steering = f.coordinator.wait(f.caller, 300_000);
	f.coordinator.notifyInput("/root");
	assert.match((await steering).message, /new input/);
	const abort = new AbortController();
	const aborted = f.coordinator.wait(f.caller, 30000, abort.signal);
	abort.abort(new Error("user abort"));
	await assert.rejects(aborted, /user abort/);
	assert.match((await f.coordinator.wait(f.caller, 30000, undefined, () => true)).message, /new input/);
});

test("default wait lasts 120 seconds without cancelling the child; completion wakes a later wait", { timeout: 10_000 }, async t => {
	const finish = deferred<string>();
	const f = await fixture(t, { reply: () => finish.promise });
	await f.coordinator.spawn(f.caller, { task_name: "worker", message: "long task" });
	await waitUntil(() => f.requests.length === 1);
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let settled = false;
	const waiting = f.coordinator.wait(f.caller).then(result => { settled = true; return result; });
	t.mock.timers.tick(119_999);
	await Promise.resolve();
	assert.equal(settled, false);
	t.mock.timers.tick(1);
	assert.deepEqual(await waiting, {
		message: "No new mailbox activity before the wait deadline. This timeout does not cancel agents or indicate task failure.",
		timed_out: true,
	});
	assert.equal(f.coordinator.treeStore.record("/root/worker").status, "running");
	assert.equal(f.coordinator.activeCount, 1);
	t.mock.timers.reset();
	const completion = f.coordinator.wait(f.caller, 300_000);
	finish.resolve("long task complete");
	assert.equal((await completion).timed_out, false);
	await f.idle();
	assert.equal(f.requests.length, 1);
	assert.equal(f.coordinator.treeStore.record("/root/worker").status, "completed");
	assert.equal(f.coordinator.treeStore.mailbox("/root")[0]?.text, "long task complete");
});

test("explicit timeout overrides the default", async t => {
	const f = await fixture(t);
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let settled = false;
	const waiting = f.coordinator.wait(f.caller, 300_000).then(result => { settled = true; return result; });
	t.mock.timers.tick(299_999);
	await Promise.resolve();
	assert.equal(settled, false);
	t.mock.timers.tick(1);
	assert.equal((await waiting).timed_out, true);
});

test("wait timeout limits and shutdown do not consume future mail", async t => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = await fixture(t);
	const waiting = f.coordinator.wait(f.caller, 0);
	t.mock.timers.tick(9999);
	t.mock.timers.tick(1);
	assert.deepEqual(await waiting, {
		message: "No new mailbox activity before the wait deadline. This timeout does not cancel agents or indicate task failure. Timeout raised to 10000 ms.",
		timed_out: true,
	});
	for (const invalid of [-1, 1.5, 3600001]) assert.throws(() => f.coordinator.wait(f.caller, invalid), /timeout_ms/);
	const next = f.coordinator.wait(f.caller);
	const rejection = assert.rejects(next, /interrupted/);
	await f.coordinator.shutdown();
	await rejection;
});

test("interrupt stops only current run, preserves mailbox/history, and allows later work", async t => {
	const finish = deferred<string>();
	const f = await fixture(t, { reply: (_ctx, n) => n === 1 ? finish.promise : "new task complete" });
	await f.coordinator.spawn(f.caller, { task_name: "worker", message: "start" });
	await waitUntil(() => f.requests.length === 1);
	f.coordinator.send(f.caller, "worker", "keep this message");
	assert.deepEqual(f.coordinator.interrupt(f.caller, "worker"), { previous_status: "running" });
	await f.idle();
	assert.equal(f.coordinator.treeStore.record("/root/worker").status, "interrupted");
	assert.equal(f.coordinator.treeStore.mailbox("/root").length, 0);
	assert.equal(f.coordinator.treeStore.mailbox("/root/worker").length, 1);
	await f.coordinator.followup(f.caller, "worker", "new task");
	await f.idle();
	assert.match(JSON.stringify(f.requests.at(-1)), /keep this message/);
	assert.equal(f.coordinator.treeStore.record("/root/worker").status, "completed");
	assert.deepEqual(f.coordinator.interrupt(f.caller, "worker"), { previous_status: "completed" });
});

test("a followup after interruption is not killed by the old cancellation", async t => {
	const finish = deferred<string>();
	const f = await fixture(t, { reply: (_ctx, n) => n === 1 ? finish.promise : "restarted" });
	await f.coordinator.spawn(f.caller, { task_name: "worker", message: "start" });
	await waitUntil(() => f.requests.length === 1);
	f.coordinator.interrupt(f.caller, "worker");
	await f.coordinator.followup(f.caller, "worker", "followup after interrupt");
	await f.idle();
	assert.equal(f.coordinator.treeStore.record("/root/worker").status, "completed");
	assert.match(JSON.stringify(f.requests.at(-1)), /followup after interrupt/);
});

test("capacity fails fast without phantom agents; settled agents do not occupy slots", async t => {
	const finish = deferred<string>();
	const f = await fixture(t, { settings: { maxConcurrentAgents: 1 }, reply: (_ctx, n) => n === 1 ? finish.promise : "done" });
	await f.coordinator.spawn(f.caller, { task_name: "a", message: "work" });
	await assert.rejects(f.coordinator.spawn(f.caller, { task_name: "b", message: "work" }), /capacity/);
	assert.equal(f.coordinator.list(f.caller).agents.length, 2);
	finish.resolve("done");
	await f.idle();
	await f.coordinator.spawn(f.caller, { task_name: "b", message: "work" });
	await f.idle();
	assert.equal(f.coordinator.list(f.caller).agents.length, 3);
});

test("duplicate parallel spawn names reserve once, unknown roles and no-session fail", async t => {
	const f = await fixture(t);
	const results = await Promise.allSettled([
		f.coordinator.spawn(f.caller, { task_name: "same", message: "a" }),
		f.coordinator.spawn(f.caller, { task_name: "same", message: "b" }),
	]);
	assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
	await f.idle();
	await assert.rejects(f.coordinator.spawn(f.caller, { task_name: "unknown", message: "a", agent_type: "missing" }), /unknown agent_type/);
	const ephemeral = await fixture(t, { persistent: false });
	await assert.rejects(ephemeral.coordinator.spawn(ephemeral.caller, { task_name: "a", message: "a" }), /persisted root/);
	assert.equal(ephemeral.coordinator.list(ephemeral.caller).agents.length, 1);
});

test("root and child tool definitions match, removed tools absent, permissions enforced", async t => {
	const f = await fixture(t);
	await f.coordinator.spawn(f.caller, { task_name: "scout", message: "work", agent_type: "scout" });
	await f.idle();
	const tools = getCurrentTools(f.requests[0]!.messages);
	const expected = createAgentTools(f.coordinator, () => f.caller, f.coordinator.catalog(f.caller).agents);
	for (const definition of expected) {
		const child = tools.find(tool => tool.name === definition.name);
		assert.ok(child, definition.name);
		assert.equal(child.description, definition.description);
		assert.deepEqual(JSON.parse(JSON.stringify(child.parameters)), JSON.parse(JSON.stringify(definition.parameters)));
	}
	assert(!tools.some(tool => ["subagent", "subagent_fork", "report", "bash", "write", "edit"].includes(tool.name)));
});

test("cold restart restores mailbox and identity without auto execution", async t => {
	const f = await fixture(t);
	await f.coordinator.spawn(f.caller, { task_name: "worker", message: "start" });
	await f.idle();
	const record = structuredClone(f.coordinator.treeStore.record("/root/worker"));
	f.coordinator.send(f.caller, "worker", "durable unread");
	await f.restart();
	assert.equal(f.requests.length, 1);
	assert.equal(f.coordinator.treeStore.record("/root/worker").descriptor.id, record.descriptor.id);
	await f.coordinator.followup(f.caller, "worker", "continue");
	await f.idle();
	assert.match(JSON.stringify(f.requests.at(-1)), /durable unread/);
	assert.equal(f.coordinator.treeStore.record("/root/worker").sessionFile, record.sessionFile);
});

test("cross-agent messaging works and completion always goes to structural parent", async t => {
	const f = await fixture(t);
	for (const task_name of ["a", "b"]) await f.coordinator.spawn(f.caller, { task_name, message: task_name });
	await f.idle();
	const a = f.coordinator.treeStore.record("/root/a");
	const callerA: AgentCaller = {
		...f.caller, path: "/root/a", depth: 1, sessionManager: SessionManager.open(a.sessionFile),
	};
	f.coordinator.send(callerA, "/root", "child to root");
	f.coordinator.send(callerA, "/root/b", "sibling context");
	await f.coordinator.followup(callerA, "/root/b", "sibling task");
	await f.idle();
	assert.equal(f.coordinator.treeStore.mailbox("/root/b").length, 0);
	assert.equal(f.coordinator.treeStore.mailbox("/root/a").length, 0);
	assert.equal(f.coordinator.treeStore.mailbox("/root").filter(message => message.from === "/root/b").length, 2);
	assert.throws(() => f.coordinator.send(callerA, "b", "invalid relative sibling"), /unknown agent/);
	await assert.rejects(f.coordinator.followup(callerA, "/root", "not allowed"), /cannot start/);
	assert.throws(() => f.coordinator.interrupt(callerA, "/root/a"), /yourself/);
	assert.throws(() => f.coordinator.interrupt(callerA, "/root"), /root/);
});

test("nested delegation shares the capacity/depth policy and needs no resident parent", async t => {
	let childSpawned = false;
	const f = await fixture(t, { settings: { maxDepth: 2 }, reply: (context) => {
		const text = JSON.stringify(context.messages);
		if (text.includes("make grandchild") && !childSpawned) {
			childSpawned = true;
			return [{ type: "toolCall", id: "spawn_nested", name: "spawn_agent",
				arguments: { task_name: "nested", message: "grandchild work", fork_turns: "none" } }];
		}
		return "done";
	} });
	await f.coordinator.spawn(f.caller, { task_name: "parent", message: "make grandchild", fork_turns: "none" });
	await f.idle();
	assert(f.coordinator.list(f.caller).agents.some(agent => agent.agent_name === "/root/parent/nested"));
	const grandchild = f.coordinator.treeStore.record("/root/parent/nested");
	const nestedCaller: AgentCaller = {
		...f.caller, path: "/root/parent/nested", depth: 2, sessionManager: SessionManager.open(grandchild.sessionFile),
	};
	await assert.rejects(f.coordinator.spawn(nestedCaller, { task_name: "too_deep", message: "no" }), /depth/);
});

test("active-branch visibility excludes abandoned children and their messages", async t => {
	const f = await fixture(t);
	const anchor = f.manager.getLeafId()!;
	await f.coordinator.spawn(f.caller, { task_name: "abandoned", message: "a" });
	await f.idle();
	f.manager.branch(anchor);
	assert.equal(f.coordinator.list(f.caller).agents.length, 1);
	assert.equal(f.coordinator.inboxMessage("/root", f.manager), undefined);
	assert.throws(() => f.coordinator.send(f.caller, "/root/abandoned", "no"), /unknown agent/);
	await f.restart();
	assert.equal(f.coordinator.list(f.caller).agents.length, 1);
});

test("a task from an abandoned sibling cannot trigger undeliverable restart loops", async t => {
	const finish = deferred<string>();
	const f = await fixture(t, { reply: (_ctx, n) => n === 1 ? finish.promise :
		n < 5 ? "done" : { error: "runaway guard" } });
	await f.coordinator.spawn(f.caller, { task_name: "a", message: "initial a", fork_turns: "none" });
	await waitUntil(() => f.requests.length === 1);
	const beforeB = f.manager.getLeafId()!;
	await f.coordinator.spawn(f.caller, { task_name: "b", message: "initial b", fork_turns: "none" });
	await waitUntil(() => f.coordinator.treeStore.record("/root/b").status === "completed");
	const callerB: AgentCaller = {
		...f.caller, path: "/root/b", depth: 1,
		sessionManager: SessionManager.open(f.coordinator.treeStore.record("/root/b").sessionFile),
	};
	await f.coordinator.followup(callerB, "/root/a", "hidden sibling task");
	f.coordinator.interrupt(f.caller, "a");
	await f.idle();
	f.manager.branch(beforeB);
	await f.restart();
	await f.coordinator.followup(f.caller, "a", "visible followup");
	await f.idle();
	assert.equal(f.requests.length, 3);
	assert.equal(f.coordinator.treeStore.mailbox("/root/a")[0]?.text, "hidden sibling task");
	assert.doesNotMatch(JSON.stringify(f.requests[2]), /hidden sibling task/);
});

test("strict argument validation and exact prefix filtering", async t => {
	const f = await fixture(t);
	for (const task_name of ["test", "testing"]) await f.coordinator.spawn(f.caller, { task_name, message: "work" });
	await f.idle();
	assert.deepEqual(f.coordinator.list(f.caller, "test").agents.map(agent => agent.agent_name), ["/root/test"]);
	for (const message of ["", "   ", "x".repeat(131073)]) {
		assert.throws(() => f.coordinator.send(f.caller, "test", message), /message/);
	}
	assert.throws(() => f.coordinator.send(f.caller, "../test", "no"), /task_name/);
	await assert.rejects(f.coordinator.spawn(f.caller, { task_name: "bad-name", message: "a" }), /task_name/);
	await assert.rejects(f.coordinator.spawn(f.caller, { task_name: "oversized", message: "文".repeat(100000) }), /byte capacity/);
});

test("parent mailbox overflow retains a completion outbox until context delivery frees space", async t => {
	const finish = deferred<string>();
	const f = await fixture(t, { reply: () => finish.promise });
	await f.coordinator.spawn(f.caller, { task_name: "worker", message: "work" });
	for (let n = 0; n < MAX_PENDING_MESSAGES; n++) f.coordinator.send(f.caller, "/root", `message ${n}`);
	finish.resolve("completion survives backpressure");
	await f.idle();
	assert.equal(f.coordinator.treeStore.record("/root/worker").outbox?.length, 1);
	const envelope = f.coordinator.inboxMessage("/root", f.manager)!;
	f.manager.appendCustomMessageEntry(MESSAGE_CUSTOM_TYPE, envelope.content, true, envelope.details);
	f.coordinator.reconcile("/root", f.manager);
	assert.equal(f.coordinator.treeStore.record("/root/worker").outbox?.length, 0);
	assert.equal(f.coordinator.treeStore.mailbox("/root")[0]?.text, "completion survives backpressure");
});

test("receipt on disk but absent control ACK is recovered without duplicate context delivery", async t => {
	const f = await fixture(t);
	f.coordinator.send(f.caller, "/root", "once");
	const envelope = f.coordinator.inboxMessage("/root", f.manager)!;
	f.manager.appendCustomMessageEntry(envelope.customType, envelope.content, true, envelope.details);
	assert.equal(f.coordinator.treeStore.mailbox("/root").length, 1);
	await f.restart();
	assert.equal(f.coordinator.inboxMessage("/root", f.manager), undefined);
});

test("recovered running records become interrupted and are not rerun", async t => {
	const f = await fixture(t);
	await f.coordinator.spawn(f.caller, { task_name: "worker", message: "work" });
	await f.idle();
	f.coordinator.treeStore.update(state => { state.agents["/root/worker"]!.status = "running"; });
	await f.restart();
	assert.equal(f.requests.length, 1);
	assert.equal(f.coordinator.treeStore.record("/root/worker").status, "interrupted");
});

test("old descriptor versions in control store fail rather than migrating", async t => {
	const f = await fixture(t);
	await f.coordinator.spawn(f.caller, { task_name: "worker", message: "work" });
	await f.idle();
	const store = f.coordinator.treeStore;
	const file = join(store.directory, "state.json");
	const data = JSON.parse(readFileSync(file, "utf8"));
	data.agents["/root/worker"].descriptor.version = 4;
	writeFileSync(file, JSON.stringify(data));
	assert.throws(() => new TreeStore(f.manager.getSessionDir(), store.snapshot.id, f.manager.getSessionId()), /descriptor/);
});

test("SDK preflight handled input rejects acceptance and leaves task recoverable", async t => {
	const f = await fixture(t, {
		settings: { inheritExtensions: true },
		extension: `export default function(pi) { pi.on("input", () => ({action:"handled"})); }`,
	});
	await assert.rejects(f.coordinator.spawn(f.caller, { task_name: "worker", message: "work" }), /handled/);
	await f.idle();
	assert.equal(f.requests.length, 0);
	assert.equal(f.coordinator.treeStore.mailbox("/root/worker").filter(message => message.kind === "task").length, 1);
});

test("configured tool ceilings cannot be expanded by nested roles or late extensions", async t => {
	const f = await fixture(t, {
		settings: { inheritExtensions: true },
		extension: `export default function(pi) { pi.registerTool({name:"late",label:"Late",description:"Excluded",parameters:{type:"object",properties:{}}, execute:async()=>({content:[],details:{}})}); }`,
	});
	await f.coordinator.spawn(f.caller, { task_name: "empty", message: "work", agent_type: "empty" });
	await f.idle();
	assert(!getCurrentTools(f.requests[0]!.messages).some(tool => tool.name === "late"));
	const record = f.coordinator.treeStore.record("/root/empty");
	const caller: AgentCaller = { ...f.caller, path: "/root/empty", depth: 1, tools: [], sessionManager: SessionManager.open(record.sessionFile) };
	await assert.rejects(f.coordinator.spawn(caller, { task_name: "broader", message: "no", agent_type: "scout" }), /ceiling/);
});

test("shutdown cancels waiters and active work, drains admission, is idempotent", async t => {
	const finish = deferred<string>();
	const f = await fixture(t, { reply: () => finish.promise });
	await f.coordinator.spawn(f.caller, { task_name: "worker", message: "work" });
	const waiting = assert.rejects(f.coordinator.wait(f.caller), /interrupted/);
	await Promise.all([f.coordinator.shutdown(), f.coordinator.shutdown()]);
	await waiting;
	assert.equal(f.coordinator.activeCount, 0);
	assert.equal(f.coordinator.treeStore.record("/root/worker").status, "interrupted");
});

test("project extensions and settings remain untrusted inside inherited children", async t => {
	const f = await fixture(t, { trusted: false, settings: { inheritExtensions: true } });
	mkdirSync(join(f.root, ".pi", "extensions"), { recursive: true });
	writeFileSync(join(f.root, ".pi", "extensions", "untrusted.js"), `
		export default function(pi) {
			pi.registerTool({name:"untrusted_project_tool",label:"Bad",description:"Must not load",
				parameters:{type:"object",properties:{}},execute:async()=>({content:[],details:{}})});
		}`);
	writeFileSync(join(f.root, ".pi", "settings.json"), JSON.stringify({ defaultTools: ["untrusted_project_tool"] }));
	await f.coordinator.spawn(f.caller, { task_name: "worker", message: "work" });
	await f.idle();
	assert(!getCurrentTools(f.requests[0]!.messages).some(tool => tool.name === "untrusted_project_tool"));
});

test("compaction cannot hide final output or usage from the runtime", async t => {
	const f = await fixture(t, {
		settings: { inheritExtensions: true },
		extension: `export default function(pi) {
			let compacted = false;
			pi.on("turn_end", () => {
				if (compacted) return;
				compacted = true;
				return {entries:[{type:"compaction",summary:"short summary",firstKeptEntryId:null,
					usage:{input:5,output:2,cacheRead:0,cacheWrite:0,totalTokens:7,
					cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}],continue:true};
			});
		}`,
	});
	await f.coordinator.spawn(f.caller, { task_name: "worker", message: "work" });
	await f.idle();
	assert.equal(f.requests.length, 2);
	assert.equal(f.coordinator.treeStore.record("/root/worker").status, "completed");
	assert.equal(f.coordinator.treeStore.mailbox("/root")[0]?.text, "answer 2");
	const usage = f.manager.getEntries().flatMap(entry => entry.type === "usage" ? [entry.usage.totalTokens] : []);
	assert.equal(usage.reduce((sum, value) => sum + value, 0), 11);
});

for (const failing of [false, true]) {
	test(`followup after final boundary starts a new run (error=${failing})`, async t => {
		const reached = deferred();
		const resume = deferred();
		const key = `__pi_subagent_settle_${failing}`;
		(globalThis as any)[key] = { reached, resume };
		t.after(() => { delete (globalThis as any)[key]; });
		const f = await fixture(t, {
			settings: { inheritExtensions: true },
			reply: (_ctx, n) => n === 1 && failing ? { error: "quota denied" } : `answer ${n}`,
			extension: `export default function(pi) {
				let once = false;
				pi.on("agent_settled", async () => {
					if(once) return; once = true;
					globalThis["${key}"].reached.resolve();
					await globalThis["${key}"].resume.promise;
				});
			}`,
		});
		await f.coordinator.spawn(f.caller, { task_name: "worker", message: "first" });
		await reached.promise;
		try {
			await f.coordinator.followup(f.caller, "worker", "accepted after closing boundary");
		} finally { resume.resolve(); }
		await f.idle();
		assert.equal(f.requests.length, 2);
		assert.equal(f.coordinator.treeStore.record("/root/worker").status, "completed");
		const results = f.coordinator.treeStore.mailbox("/root");
		assert.equal(results.length, 2);
		if (failing) assert.match(results[0]!.text, /quota denied/);
		assert.match(JSON.stringify(f.requests[1]), /accepted after closing boundary/);
	});
}

test("immediate interrupt at spawn acceptance cannot miss SDK startup", async t => {
	const finish = deferred<string>();
	const f = await fixture(t, { reply: () => finish.promise });
	await f.coordinator.spawn(f.caller, { task_name: "worker", message: "work" });
	f.coordinator.interrupt(f.caller, "worker");
	await f.idle();
	assert.equal(f.coordinator.treeStore.record("/root/worker").status, "interrupted");
});

test("caller cancellation after acceptance does not own background work", async t => {
	const finish = deferred<string>();
	const f = await fixture(t, { reply: () => finish.promise });
	const signal = new AbortController();
	await f.coordinator.spawn(f.caller, { task_name: "worker", message: "work" }, signal.signal);
	signal.abort();
	finish.resolve("independent result");
	await f.idle();
	assert.equal(f.coordinator.treeStore.record("/root/worker").status, "completed");
});

test("cancellation during SDK initialization rejects acceptance and releases capacity", async t => {
	const reached = deferred();
	const resume = deferred();
	(globalThis as any).__pi_subagent_init_gate = { reached, resume };
	t.after(() => { delete (globalThis as any).__pi_subagent_init_gate; });
	const f = await fixture(t, {
		settings: { inheritExtensions: true },
		extension: `export default function(pi) {
			pi.on("session_start", async () => {
				globalThis.__pi_subagent_init_gate.reached.resolve();
				await globalThis.__pi_subagent_init_gate.resume.promise;
			});
		}`,
	});
	const controller = new AbortController();
	const spawn = f.coordinator.spawn(f.caller, { task_name: "worker", message: "work" }, controller.signal);
	const rejection = assert.rejects(spawn, /cancelled initialization/);
	await reached.promise;
	controller.abort(new Error("cancelled initialization"));
	resume.resolve();
	await rejection;
	await f.idle();
	assert.equal(f.requests.length, 0);
	assert.equal(f.coordinator.treeStore.record("/root/worker").status, "interrupted");
	assert.equal(f.coordinator.treeStore.mailbox("/root/worker").length, 1);
});

test("cold runtime retains Codex identity independently from transport and context", async t => {
	const f = await fixture(t, { settings: { openAIIdentity: true } });
	await f.coordinator.spawn(f.caller, { task_name: "worker", message: "work" });
	await f.idle();
	const file = f.coordinator.treeStore.record("/root/worker").sessionFile;
	const identities = SessionManager.open(file).getEntries().filter(entry =>
		entry.type === "custom" && entry.customType.includes("codex") && entry.customType.includes("identity"));
	assert(identities.length > 0);
	await f.coordinator.followup(f.caller, "worker", "continue");
	await f.idle();
	const later = SessionManager.open(file).getEntries().filter(entry =>
		entry.type === "custom" && entry.customType.includes("codex") && entry.customType.includes("identity"));
	assert.deepEqual(later, identities);
	assert.doesNotMatch(JSON.stringify(f.requests), /customType.*identity/);
});

test("followup racing idle disposal waits for a single replacement runtime", async t => {
	const reached = deferred();
	const resume = deferred();
	(globalThis as any).__pi_subagent_disposal = { reached, resume };
	t.after(() => { delete (globalThis as any).__pi_subagent_disposal; });
	const f = await fixture(t, {
		settings: { inheritExtensions: true },
		extension: `export default function(pi) {
			pi.on("session_shutdown", async () => {
				globalThis.__pi_subagent_disposal.reached.resolve();
				await globalThis.__pi_subagent_disposal.resume.promise;
			});
		}`,
	});
	await f.coordinator.spawn(f.caller, { task_name: "worker", message: "first" });
	await reached.promise;
	const followup = f.coordinator.followup(f.caller, "worker", "next after dispose");
	resume.resolve();
	await followup;
	await f.idle();
	assert.equal(f.requests.length, 2);
	assert.match(JSON.stringify(f.requests[1]), /next after dispose/);
	assert.equal(f.coordinator.treeStore.mailbox("/root/worker").length, 0);
});
