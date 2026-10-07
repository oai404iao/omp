import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	beginCodexTurn, codexThreadIdentityFor, currentCodexTurn, endCodexTurn, resetCodexWireState,
} from "../../pi-codex-runtime/src/codex-wire-identity.ts";
import { CODEX_TURN_ATTRIBUTION_CHANNEL } from "../src/task-attribution.ts";
import { deferred, fixture, stream, usage, waitUntil } from "./support/fixture.ts";

function bindCapture(f: Awaited<ReturnType<typeof fixture>>) {
	const emit = f.pi.events.emit.bind(f.pi.events);
	f.pi.events.emit = (name, value) => {
		if (name === CODEX_TURN_ATTRIBUTION_CHANNEL) {
			const request = value as { sessionId: string; accept: (value: unknown) => void };
			const turn = currentCodexTurn(request.sessionId);
			request.accept(turn ? { parentTurnId: turn.turnId, rootTurnId: turn.rootTurnId ?? turn.turnId } : {});
		}
		emit(name, value);
	};
}

function childTurn(f: Awaited<ReturnType<typeof fixture>>) {
	const child = SessionManager.open(f.coordinator.treeStore.record("/root/worker").sessionFile);
	return currentCodexTurn(child.getSessionId());
}

test("spawn captures the caller turn before asynchronous child initialization", async t => {
	t.after(resetCodexWireState);
	const observed: ReturnType<typeof currentCodexTurn>[] = [];
	const f = await fixture(t, {
		settings: { openAIIdentity: true },
		reply: () => { observed.push(childTurn(f)); return "done"; },
	});
	bindCapture(f);
	const parent = beginCodexTurn(f.manager.getSessionId());
	const accepted = f.coordinator.spawn(f.caller, { task_name: "worker", message: "work", fork_turns: "none" });
	endCodexTurn(f.manager.getSessionId());
	await accepted;
	await f.idle();
	assert.equal(observed.length, 1);
	assert.equal(observed[0]?.parentTurnId, parent.turnId);
	assert.equal(observed[0]?.rootTurnId, parent.rootTurnId);
	const child = SessionManager.open(f.coordinator.treeStore.record("/root/worker").sessionFile);
	assert.equal(codexThreadIdentityFor(child.getSessionId())?.sessionId,
		codexThreadIdentityFor(f.manager.getSessionId())?.sessionId);
	assert.equal(codexThreadIdentityFor(child.getSessionId())?.agentName, "/root/worker");
	const envelope = child.getBranch().find(entry => entry.type === "custom_message" &&
		(entry.details as any)?.codexTurnAttribution?.parentTurnId === parent.turnId);
	assert.ok(envelope);
	await f.coordinator.followup(f.caller, "worker", "no current caller turn");
	await f.idle();
	assert.equal(observed[1]?.parentTurnId, undefined);
	assert.equal(observed[1]?.rootTurnId, observed[1]?.turnId);
});

test("active followup does not replace running attribution; cold followup uses its captured caller", async t => {
	t.after(resetCodexWireState);
	const finish = deferred<string>();
	const observed: ReturnType<typeof currentCodexTurn>[] = [];
	const f = await fixture(t, {
		settings: { openAIIdentity: true },
		reply: (_context, request) => {
			observed.push(childTurn(f));
			return request === 1 ? finish.promise : "done";
		},
	});
	bindCapture(f);
	const rootId = f.manager.getSessionId();
	const first = beginCodexTurn(rootId);
	await f.coordinator.spawn(f.caller, { task_name: "worker", message: "first", fork_turns: "none" });
	await waitUntil(() => observed.length === 1);
	endCodexTurn(rootId);
	const second = beginCodexTurn(rootId);
	const queued = f.coordinator.followup(f.caller, "worker", "while running");
	endCodexTurn(rootId);
	await queued;
	assert.equal(childTurn(f)?.parentTurnId, first.turnId);
	assert.deepEqual(f.coordinator.treeStore.mailbox("/root/worker").find(message => message.text === "while running")?.codexTurnAttribution, {
		parentTurnId: second.turnId, rootTurnId: second.rootTurnId,
	});
	finish.resolve("first answer");
	await f.idle();
	assert.equal(observed[1]?.turnId, observed[0]?.turnId);
	assert.equal(observed[1]?.parentTurnId, first.turnId);
	const third = beginCodexTurn(rootId);
	const resumed = f.coordinator.followup(f.caller, "worker", "cold followup");
	endCodexTurn(rootId);
	await resumed;
	await f.idle();
	assert.equal(observed[2]?.parentTurnId, third.turnId);
	assert.equal(observed[2]?.rootTurnId, third.rootTurnId);
	assert.notEqual(observed[2]?.turnId, observed[0]?.turnId);
});

test("pending task attribution survives interrupt, runtime unload and coordinator reload", async t => {
	t.after(resetCodexWireState);
	const finish = deferred<string>();
	const observed: ReturnType<typeof currentCodexTurn>[] = [];
	const f = await fixture(t, {
		settings: { openAIIdentity: true },
		reply: (_context, request) => {
			observed.push(childTurn(f));
			return request === 1 ? finish.promise : "recovered";
		},
	});
	bindCapture(f);
	const rootId = f.manager.getSessionId();
	beginCodexTurn(rootId);
	await f.coordinator.spawn(f.caller, { task_name: "worker", message: "first", fork_turns: "none" });
	await waitUntil(() => observed.length === 1);
	endCodexTurn(rootId);
	const cause = beginCodexTurn(rootId);
	await f.coordinator.followup(f.caller, "worker", "retained task");
	f.coordinator.interrupt(f.caller, "worker");
	await f.idle();
	endCodexTurn(rootId);
	resetCodexWireState();
	await f.restart();
	assert.equal(f.coordinator.treeStore.mailbox("/root/worker")[0]?.codexTurnAttribution?.parentTurnId, cause.turnId);
	await f.coordinator.followup(f.caller, "worker", "resume pending work");
	await f.idle();
	assert.equal(observed[1]?.parentTurnId, cause.turnId);
	assert.equal(observed[1]?.rootTurnId, cause.rootTurnId);
	finish.resolve("late result");
});

test("followup attributes a sibling initiator rather than the structural parent", async t => {
	t.after(resetCodexWireState);
	const f = await fixture(t, { settings: { openAIIdentity: true } });
	bindCapture(f);
	beginCodexTurn(f.manager.getSessionId());
	await f.coordinator.spawn(f.caller, { task_name: "worker", message: "worker", fork_turns: "none" });
	await f.idle();
	await f.coordinator.spawn(f.caller, { task_name: "sender", message: "sender", fork_turns: "none" });
	await f.idle();
	const sender = SessionManager.open(f.coordinator.treeStore.record("/root/sender").sessionFile);
	const cause = beginCodexTurn(sender.getSessionId(), { parentPiSessionId: f.manager.getSessionId() });
	const resumed = f.coordinator.followup({
		...f.caller, path: "/root/sender", depth: 1, sessionManager: sender,
	}, "/root/worker", "sibling task");
	endCodexTurn(sender.getSessionId());
	endCodexTurn(f.manager.getSessionId());
	await resumed;
	await f.idle();
	const worker = SessionManager.open(f.coordinator.treeStore.record("/root/worker").sessionFile);
	const marker = [...worker.getBranch()].reverse().find(entry =>
		entry.type === "custom" && entry.customType === "pi-codex/turn-attribution");
	assert.equal(marker?.type, "custom");
	if (marker?.type === "custom") assert.deepEqual(marker.data, {
		version: 1, parentTurnId: cause.turnId, rootTurnId: cause.rootTurnId,
	});
});

test("Responses descendants retain causal turns through a non-Responses intermediate", async t => {
	t.after(resetCodexWireState);
	const finishIntermediate = deferred<string>();
	let intermediateTurn: ReturnType<typeof currentCodexTurn>;
	let descendantTurn: ReturnType<typeof currentCodexTurn>;
	const f = await fixture(t, {
		settings: { openAIIdentity: true, maxConcurrentAgents: 2 },
		reply: () => {
			const descendant = SessionManager.open(f.coordinator.treeStore.record("/root/worker/nested").sessionFile);
			descendantTurn = currentCodexTurn(descendant.getSessionId());
			return "nested done";
		},
	});
	bindCapture(f);
	f.modelRuntime.registerProvider("nonresponses", {
		baseUrl: "http://scripted.invalid", apiKey: "test", api: "anthropic-messages",
		models: [{ id: "echo", name: "Echo", reasoning: false, input: ["text"],
			cost: usage.cost, contextWindow: 100000, maxTokens: 1000 }],
		streamSimple: (model, _context, options) => {
			intermediateTurn = currentCodexTurn(options?.sessionId);
			return stream(model, finishIntermediate.promise, options?.signal);
		},
	});
	const rootTurn = beginCodexTurn(f.manager.getSessionId());
	const spawned = f.coordinator.spawn({
		...f.caller, model: f.modelRuntime.getModel("nonresponses", "echo"),
	}, { task_name: "worker", message: "delegate nested work", fork_turns: "none" });
	endCodexTurn(f.manager.getSessionId());
	await spawned;
	await waitUntil(() => intermediateTurn !== undefined);
	assert.equal(intermediateTurn?.parentTurnId, rootTurn.turnId);
	assert.equal(intermediateTurn?.rootTurnId, rootTurn.turnId);
	const intermediate = SessionManager.open(f.coordinator.treeStore.record("/root/worker").sessionFile);
	assert(!intermediate.getEntries().some(entry =>
		entry.type === "custom" && entry.customType === "pi-codex/thread-identity"));
	const nested = f.coordinator.spawn({
		...f.caller, path: "/root/worker", depth: 1, sessionManager: intermediate, model: f.model,
	}, { task_name: "nested", message: "nested task", fork_turns: "none" });
	finishIntermediate.resolve("intermediate done");
	await nested;
	await f.idle();
	assert.equal(descendantTurn?.parentTurnId, intermediateTurn?.turnId);
	assert.equal(descendantTurn?.rootTurnId, rootTurn.turnId);
	assert.notEqual(descendantTurn?.rootTurnId, descendantTurn?.turnId);
});
