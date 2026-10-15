import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentCaller } from "../src/coordinator.ts";
import { MAX_PENDING_MESSAGES, MESSAGE_CUSTOM_TYPE, TreeStore } from "../src/store.ts";
import { deferred, fixture, stream, usage, waitUntil } from "./support/fixture.ts";

type Fixture = Awaited<ReturnType<typeof fixture>>;
function childCaller(f: Fixture, path: string): AgentCaller {
	// A live caller must use its actual manager, not an independently opened
	// snapshot that could fork away its registration while the SDK is writing.
	const active = (f.coordinator as any).active.get(path) as { caller: AgentCaller } | undefined;
	if (active) return active.caller;
	const record = f.coordinator.treeStore.record(path);
	return { ...f.caller, path, depth: record.descriptor.depth, sessionManager: SessionManager.open(record.sessionFile) };
}

function registerProfiles(f: Fixture) {
	const selected: Array<{ model: string; reasoning: unknown }> = [];
	f.modelRuntime.registerProvider("profiles", {
		baseUrl: "http://scripted.invalid", apiKey: "test", api: "openai-responses",
		models: ["first", "second"].map(id => ({
			id, name: id, reasoning: true, input: ["text"] as ["text"],
			cost: usage.cost, contextWindow: 100000, maxTokens: 1000,
		})),
		streamSimple: (model, context, options) => {
			selected.push({ model: model.id, reasoning: options?.reasoning });
			f.requests.push(structuredClone(context));
			return stream(model, `profile ${model.id}`, options?.signal);
		},
	});
	return selected;
}

test("execution overrides beat roles; idle followup is sticky across cold resume and restart", async t => {
	const f = await fixture(t);
	const selected = registerProfiles(f);
	writeFileSync(join(f.agentDir, "agents", "profile.md"),
		"---\nname: profile\ndescription: Profile\nmodel: profiles/first\nthinking: low\n---\nRole text.\n");
	await f.coordinator.spawn(f.caller, {
		task_name: "worker", message: "initial task", agent_type: "profile", model: "profiles/second", thinking: "high",
	});
	await f.idle();
	const before = f.coordinator.treeStore.record("/root/worker");
	assert.deepEqual(before.descriptor.model, { provider: "profiles", id: "second" });
	assert.equal(before.descriptor.thinkingLevel, "high");
	assert.equal(selected[0]?.model, "second");
	assert.equal(selected[0]?.reasoning, "high");
	await f.coordinator.followup(f.caller, "worker", "next task", undefined, { model: "profiles/first", thinking: "low" });
	await f.idle();
	await f.restart();
	await f.coordinator.followup(f.caller, "worker", "sticky task");
	await f.idle();
	const after = f.coordinator.treeStore.record("/root/worker");
	assert.equal(after.descriptor.id, before.descriptor.id);
	assert.equal(after.sessionFile, before.sessionFile);
	assert.equal(after.descriptor.agent.name, "profile");
	assert.deepEqual(after.descriptor.model, { provider: "profiles", id: "first" });
	assert.equal(after.descriptor.thinkingLevel, "low");
	assert.deepEqual(selected.map(value => value.model), ["second", "first", "first"]);
	assert.match(JSON.stringify(f.requests.at(-1)), /initial task/);
	assert.match(JSON.stringify(f.requests.at(-1)), /sticky task/);
	const entries = SessionManager.open(after.sessionFile).getBranch();
	assert(entries.some(entry => entry.type === "model_change" && entry.provider === "profiles" && entry.modelId === "first"));
	assert(entries.some(entry => entry.type === "thinking_level_change" && entry.thinkingLevel === "low"));
	assert.match(JSON.stringify(f.requests.at(-1)), /Selected model: profiles\/first\. Thinking level: low/);
});

test("invalid or unavailable profiles leave task names, mailboxes and selected configuration untouched", async t => {
	const f = await fixture(t);
	const anchors = f.manager.getEntries().length;
	for (const profile of [{ model: "missing/model" }, { thinking: "high" as const }]) {
		await assert.rejects(f.coordinator.spawn(f.caller, { task_name: "worker", message: "invalid", ...profile }),
			/unknown model|unsupported/);
	}
	assert.equal(f.manager.getEntries().length, anchors);
	assert.equal(f.coordinator.treeStore.snapshot.agents["/root/worker"], undefined);
	assert.equal(f.coordinator.activeCount, 0);
	await f.coordinator.spawn(f.caller, { task_name: "worker", message: "valid" });
	await f.idle();
	const before = structuredClone(f.coordinator.treeStore.record("/root/worker"));
	await assert.rejects(f.coordinator.followup(f.caller, "worker", "not queued", undefined, { model: "missing/model" }), /unknown/);
	await assert.rejects(f.coordinator.followup(f.caller, "worker", "not queued", undefined, { thinking: "high" }), /unsupported/);
	t.mock.method(f.modelRuntime, "getAvailable", async () => []);
	await assert.rejects(f.coordinator.followup(f.caller, "worker", "no credential", undefined, { model: "scripted/echo" }), /unavailable/);
	assert.deepEqual(f.coordinator.treeStore.record("/root/worker"), before);
	assert.equal(f.requests.length, 1);
});

test("busy changed profiles reject atomically; identical effective profiles remain queueable", async t => {
	const finish = deferred<string>();
	const f = await fixture(t, { reply: (_ctx, n) => n === 1 ? finish.promise : "continued" });
	registerProfiles(f);
	await f.coordinator.spawn(f.caller, { task_name: "worker", message: "initial" });
	await waitUntil(() => f.requests.length === 1);
	const before = structuredClone(f.coordinator.treeStore.record("/root/worker"));
	await assert.rejects(f.coordinator.followup(f.caller, "worker", "reject me", undefined, { model: "profiles/first" }), /busy/);
	assert.deepEqual(f.coordinator.treeStore.record("/root/worker"), before);
	await f.coordinator.followup(f.caller, "worker", "same pair", undefined, { model: "scripted/echo", thinking: "off" });
	const accepted = structuredClone(f.coordinator.treeStore.record("/root/worker"));
	t.mock.method(f.modelRuntime, "getAvailable", async () => []);
	await assert.rejects(f.coordinator.followup(f.caller, "worker", "omitted unavailable"), /unavailable/);
	await assert.rejects(f.coordinator.followup(f.caller, "worker", "same unavailable", undefined,
		{ model: "scripted/echo", thinking: "off" }), /unavailable/);
	assert.deepEqual(f.coordinator.treeStore.record("/root/worker"), accepted);
	finish.resolve("done");
	await f.idle();
	assert.equal(f.requests.length, 2);
	assert.match(JSON.stringify(f.requests[1]), /same pair/);
	assert.doesNotMatch(JSON.stringify(f.requests), /reject me/);
});

test("a failed configuration/task snapshot commits neither half", async t => {
	const f = await fixture(t);
	registerProfiles(f);
	await f.coordinator.spawn(f.caller, { task_name: "worker", message: "initial" });
	await f.idle();
	const before = structuredClone(f.coordinator.treeStore.record("/root/worker"));
	const file = join(f.coordinator.treeStore.directory, "state.json");
	const disk = readFileSync(file, "utf8");
	const update = f.coordinator.treeStore.update.bind(f.coordinator.treeStore);
	t.mock.method(f.coordinator.treeStore, "update", (change: Parameters<TreeStore["update"]>[0]) => update(state => {
		change(state);
		if (state.agents["/root/worker"]!.mailbox.some(message => message.text === "atomic task")) {
			throw new Error("simulated snapshot failure");
		}
	}));
	await assert.rejects(f.coordinator.followup(f.caller, "worker", "atomic task", undefined,
		{ model: "profiles/first", thinking: "high" }), /snapshot failure/);
	assert.deepEqual(f.coordinator.treeStore.record("/root/worker"), before);
	assert.equal(readFileSync(file, "utf8"), disk);
	assert.equal(f.coordinator.activeCount, 0);
	assert.equal(f.requests.length, 1);
});

test("selection mirror failure rolls back an unreceived followup and repairs partial Pi records on retry", async t => {
	const f = await fixture(t);
	registerProfiles(f);
	await f.coordinator.spawn(f.caller, {
		task_name: "worker", message: "initial", model: "profiles/first", thinking: "high",
	});
	await f.idle();
	const before = structuredClone(f.coordinator.treeStore.record("/root/worker"));
	const append = SessionManager.prototype.appendModelChange;
	let failed = false;
	t.mock.method(SessionManager.prototype, "appendModelChange", function (this: SessionManager, provider: string, modelId: string) {
		const id = append.call(this, provider, modelId);
		if (modelId === "second" && !failed) {
			failed = true;
			throw new Error("simulated post-append mirror write failure");
		}
		return id;
	});
	await assert.rejects(f.coordinator.followup(f.caller, "worker", "unaccepted", undefined,
		{ model: "profiles/second", thinking: "low" }), /persist child execution profile selection/);
	assert(failed);
	assert.deepEqual(f.coordinator.treeStore.record("/root/worker"), before);
	assert.equal(f.coordinator.activeCount, 0);
	await f.coordinator.followup(f.caller, "worker", "retry authoritative pair");
	await f.idle();
	assert.equal(f.requests.length, 2);
	assert.doesNotMatch(JSON.stringify(f.requests.at(-1)), /unaccepted/);
	const latest = [...SessionManager.open(before.sessionFile).getBranch()].reverse();
	const selection = latest.find(entry => entry.type === "model_change");
	assert(selection?.type === "model_change");
	assert.equal(selection.modelId, "first");
	assert.equal(f.coordinator.treeStore.record("/root/worker").descriptor.model.id, "first");
});

test("close is a durable subtree barrier, preserves identities and cancels pending tasks", async t => {
	const finish = deferred<string>();
	const f = await fixture(t, { settings: { maxDepth: 3 }, reply: (_ctx, n) => n <= 2 ? "done" : finish.promise });
	await f.coordinator.spawn(f.caller, { task_name: "a", message: "parent" });
	await f.coordinator.spawn(f.caller, { task_name: "ab", message: "sibling" });
	await f.idle();
	const a = childCaller(f, "/root/a");
	await f.coordinator.spawn(a, { task_name: "child", message: "running child" });
	const child = childCaller(f, "/root/a/child");
	await f.coordinator.spawn(child, { task_name: "nested", message: "running descendant" });
	await f.coordinator.followup(f.caller, "/root/a/child", "pending task");
	const wait = f.coordinator.wait(a, 300000);
	const rejection = assert.rejects(wait, /interrupted/);
	assert.throws(() => f.coordinator.close(childCaller(f, "/root/ab"), "/root/a"), /structural descendant/);
	assert.throws(() => f.coordinator.close(a, "/root/a"), /yourself/);
	assert.throws(() => f.coordinator.close(a, "/root"), /non-root/);
	assert.deepEqual(f.coordinator.close(f.caller, "a"), {
		accepted: true, target: "/root/a", lifecycle: "closing", affected_count: 3,
	});
	await rejection;
	assert.throws(() => f.coordinator.send(f.caller, "/root/a/child", "no"), /closing|closed/);
	assert.throws(() => f.coordinator.send(a, "/root", "no"), /closing|closed/);
	await assert.rejects(f.coordinator.followup(a, "/root/ab", "no"), /closing|closed/);
	await assert.rejects(f.coordinator.spawn(a, { task_name: "late", message: "no" }), /closing|closed/);
	await f.idle();
	for (const path of ["/root/a", "/root/a/child", "/root/a/child/nested"]) {
		const record = f.coordinator.treeStore.record(path);
		assert.equal(record.lifecycle, "closed");
		assert.equal(record.closedBy, "/root");
		assert(record.closeRequestedAt);
		assert(record.closedAt);
	}
	const task = f.coordinator.treeStore.record("/root/a/child").mailbox.find(message => message.text === "pending task");
	assert(task?.canceledAt);
	assert.equal(task?.canceledBy, "/root");
	assert.equal(f.coordinator.treeStore.record("/root/ab").lifecycle, "open");
	assert(!f.coordinator.list(f.caller).agents.some(agent => agent.agent_name.startsWith("/root/a/")));
	assert.equal(f.coordinator.list(f.caller, undefined, { include_closed: true }).agents.length, 5);
	assert.equal(f.coordinator.close(f.caller, "a").lifecycle, "closed");
	await assert.rejects(f.coordinator.spawn(f.caller, { task_name: "a", message: "reserved" }), /already used/);
	await f.restart();
	assert.equal(f.coordinator.treeStore.record("/root/a").lifecycle, "closed");
	assert.throws(() => f.coordinator.send(f.caller, "a", "still no"), /closed/);
});

test("close blocks an in-flight spawn before identity publication", async t => {
	const f = await fixture(t);
	await f.coordinator.spawn(f.caller, { task_name: "parent", message: "parent" });
	await f.idle();
	const caller = childCaller(f, "/root/parent");
	const reached = deferred();
	const resume = deferred();
	const available = f.modelRuntime.getAvailable.bind(f.modelRuntime);
	t.mock.method(f.modelRuntime, "getAvailable", async (...args: Parameters<typeof available>) => {
		reached.resolve();
		await resume.promise;
		return available(...args);
	});
	const spawn = f.coordinator.spawn(caller, { task_name: "late", message: "must not start" });
	const rejected = assert.rejects(spawn, /closed|closing/);
	await reached.promise;
	f.coordinator.close(f.caller, "parent");
	resume.resolve();
	await rejected;
	assert.equal(f.coordinator.treeStore.snapshot.agents["/root/parent/late"], undefined);
	assert.equal(f.coordinator.activeCount, 0);
	assert.equal(f.requests.length, 1);
});

test("close blocks an in-flight idle profile followup without accepting configuration or task", async t => {
	const f = await fixture(t);
	registerProfiles(f);
	await f.coordinator.spawn(f.caller, { task_name: "worker", message: "initial" });
	await f.idle();
	const before = structuredClone(f.coordinator.treeStore.record("/root/worker"));
	const reached = deferred();
	const resume = deferred();
	const available = f.modelRuntime.getAvailable.bind(f.modelRuntime);
	t.mock.method(f.modelRuntime, "getAvailable", async (...args: Parameters<typeof available>) => {
		reached.resolve();
		await resume.promise;
		return available(...args);
	});
	const followup = f.coordinator.followup(f.caller, "worker", "never queued", undefined, { model: "profiles/first" });
	const rejected = assert.rejects(followup, /closed|closing/);
	await reached.promise;
	f.coordinator.close(f.caller, "worker");
	resume.resolve();
	await rejected;
	const after = f.coordinator.treeStore.record("/root/worker");
	assert.deepEqual(after.descriptor, before.descriptor);
	assert.deepEqual(after.mailbox, before.mailbox);
	assert.equal(f.requests.length, 1);
});

test("close during initialization prevents prompt acceptance and drains before closed", async t => {
	const reached = deferred();
	const resume = deferred();
	(globalThis as any).__subagent_close_init = { reached, resume };
	t.after(() => { delete (globalThis as any).__subagent_close_init; });
	const f = await fixture(t, {
		settings: { inheritExtensions: true },
		extension: `export default function(pi) {
			pi.on("session_start", async () => {
				globalThis.__subagent_close_init.reached.resolve();
				await globalThis.__subagent_close_init.resume.promise;
			});
		}`,
	});
	const spawn = f.coordinator.spawn(f.caller, { task_name: "worker", message: "never execute" });
	const rejected = assert.rejects(spawn, /closed/);
	await reached.promise;
	registerProfiles(f);
	await assert.rejects(f.coordinator.followup(f.caller, "worker", "changed while initializing", undefined,
		{ model: "profiles/first" }), /PROFILE_CHANGE_REQUIRES_IDLE/);
	assert.equal(f.coordinator.close(f.caller, "worker").lifecycle, "closing");
	resume.resolve();
	await rejected;
	await f.idle();
	assert.equal(f.requests.length, 0);
	assert.equal(f.coordinator.treeStore.record("/root/worker").lifecycle, "closed");
	assert(f.coordinator.treeStore.record("/root/worker").mailbox[0]?.canceledAt);
});

test("close at the final boundary cancels an accepted next task instead of restarting", async t => {
	const reached = deferred();
	const resume = deferred();
	(globalThis as any).__subagent_close_boundary = { reached, resume };
	t.after(() => { delete (globalThis as any).__subagent_close_boundary; });
	const f = await fixture(t, {
		settings: { inheritExtensions: true },
		extension: `export default function(pi) {
			pi.on("agent_settled", async () => {
				globalThis.__subagent_close_boundary.reached.resolve();
				await globalThis.__subagent_close_boundary.resume.promise;
			});
		}`,
	});
	await f.coordinator.spawn(f.caller, { task_name: "worker", message: "initial" });
	await reached.promise;
	await f.coordinator.followup(f.caller, "worker", "accepted before closure");
	f.coordinator.close(f.caller, "worker");
	resume.resolve();
	await f.idle();
	assert.equal(f.requests.length, 1);
	assert.equal(f.coordinator.treeStore.record("/root/worker").lifecycle, "closed");
	assert(f.coordinator.treeStore.record("/root/worker").mailbox.find(message => message.text === "accepted before closure")?.canceledAt);
});

test("closing recovery does not replay and existing completion outboxes survive close", async t => {
	const f = await fixture(t);
	for (let n = 0; n < MAX_PENDING_MESSAGES; n++) f.coordinator.send(f.caller, "/root", `full ${n}`);
	await f.coordinator.spawn(f.caller, { task_name: "worker", message: "produce result" });
	await f.idle();
	const before = f.coordinator.treeStore.record("/root/worker").outbox;
	assert.equal(before?.length, 1);
	f.coordinator.close(f.caller, "worker");
	assert.deepEqual(f.coordinator.treeStore.record("/root/worker").outbox, before);
	f.coordinator.treeStore.update(state => {
		state.agents["/root/worker"]!.lifecycle = "closing";
		state.agents["/root/worker"]!.status = "running";
	});
	await f.restart();
	assert.equal(f.requests.length, 1);
	assert.equal(f.coordinator.treeStore.record("/root/worker").lifecycle, "closed");
	assert.equal(f.coordinator.treeStore.record("/root/worker").status, "interrupted");
	assert.deepEqual(f.coordinator.treeStore.record("/root/worker").outbox, before);
	const message = f.coordinator.inboxMessage("/root", f.manager)!;
	f.manager.appendCustomMessageEntry(MESSAGE_CUSTOM_TYPE, message.content, true, message.details);
	f.coordinator.reconcile("/root", f.manager);
	assert.equal(f.coordinator.treeStore.record("/root/worker").outbox?.length, 0);
	assert.equal(f.coordinator.treeStore.mailbox("/root")[0]?.text, "answer 1");
});

test("legacy lifecycle absence normalizes open, corrupt lifecycle rejects, and closing recovers closed", async t => {
	const f = await fixture(t);
	await f.coordinator.spawn(f.caller, { task_name: "worker", message: "work" });
	await f.idle();
	const store = f.coordinator.treeStore;
	const file = join(store.directory, "state.json");
	const original = JSON.parse(readFileSync(file, "utf8"));
	delete original.agents["/root/worker"].lifecycle;
	writeFileSync(file, JSON.stringify(original));
	assert.equal(new TreeStore(f.manager.getSessionDir(), store.snapshot.id, f.manager.getSessionId()).record("/root/worker").lifecycle, "open");
	original.agents["/root/worker"].lifecycle = "invalid";
	writeFileSync(file, JSON.stringify(original));
	assert.throws(() => new TreeStore(f.manager.getSessionDir(), store.snapshot.id, f.manager.getSessionId()), /corrupt/);
	// Keep fixture shutdown/recovery on a valid snapshot.
	original.agents["/root/worker"].lifecycle = "closing";
	writeFileSync(file, JSON.stringify(original));
	await f.restart();
	assert.equal(f.coordinator.treeStore.record("/root/worker").lifecycle, "closed");
});

test("list uses bounded lexical pages, selected configuration, closure filters and scoped opaque cursors", async t => {
	const f = await fixture(t);
	await f.coordinator.spawn(f.caller, { task_name: "seed", message: "seed" });
	await f.idle();
	const seed = f.coordinator.treeStore.record("/root/seed");
	f.coordinator.treeStore.update(state => {
		for (let n = 0; n < 205; n++) {
			const record = structuredClone(seed);
			record.descriptor.path = `/root/agent_${String(n).padStart(3, "0")}`;
			state.agents[record.descriptor.path] = record;
		}
	});
	const first = f.coordinator.list(f.caller);
	assert.equal(first.agents.length, 50);
	assert.equal(first.agents[0]?.agent_name, "/root");
	assert.equal(first.agents[0]?.model, "scripted/echo");
	assert(first.next_cursor);
	const paths = first.agents.map(agent => agent.agent_name);
	let cursor: string | undefined = first.next_cursor;
	while (cursor) {
		const page = f.coordinator.list(f.caller, undefined, { cursor });
		assert(page.agents.length <= 50);
		paths.push(...page.agents.map(agent => agent.agent_name));
		cursor = page.next_cursor;
	}
	assert.equal(paths.length, 207);
	assert.equal(new Set(paths).size, 207);
	assert.deepEqual(paths, [...paths].sort());
	for (const limit of [0, 201, 1.1]) assert.throws(() => f.coordinator.list(f.caller, undefined, { limit }), /limit/);
	assert.equal(f.coordinator.list(f.caller, undefined, { limit: 200 }).agents.length, 200);
	for (const cursor of ["invalid", "", first.next_cursor + "=", Buffer.from("[]").toString("base64url")]) {
		assert.throws(() => f.coordinator.list(f.caller, undefined, { cursor }), /cursor/);
	}
	assert.throws(() => f.coordinator.list(f.caller, "seed", { cursor: first.next_cursor }), /cursor/);
	assert.throws(() => f.coordinator.list(f.caller, undefined, { cursor: first.next_cursor, include_closed: true }), /cursor/);
	const other = await fixture(t);
	assert.throws(() => other.coordinator.list(other.caller, undefined, { cursor: first.next_cursor }), /cursor/);
	f.coordinator.close(f.caller, "seed");
	assert.equal(f.coordinator.list(f.caller, "seed").agents.length, 0);
	const closed = f.coordinator.list(f.caller, "seed", { include_closed: true }).agents[0]!;
	assert.equal(closed.lifecycle, "closed");
	assert.equal(closed.model, "scripted/echo");
	assert.equal(closed.thinking, "off");
	assert.deepEqual(closed.last_response, { model: "scripted/echo", thinking: "off" });
});
