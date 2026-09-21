import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ApprovalQueue } from "../src/approvals.ts";
import { ToolBridge } from "../src/bridge.ts";
import { collect } from "../src/catalog.ts";
import { DISCOVER, CHANGED, registerCodeModeTools, registerCodeModeApproval, registerCodeModePolicy, type CodeModeTool, type CodeModePolicy, type CodeModeProvider, type PolicyCall } from "../src/contributions.ts";
import { DISCOVER_V2, type ConsumerHello, type DiscoveryOffer, type DiscoveryReceipt } from "../src/discovery.ts";
import { Cell } from "../src/cell.ts";
import extension from "../src/extension.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const signal = () => new AbortController().signal;
const call = (id: string, outer = signal()): PolicyCall => ({ name: id, effect: "write", input: {},
	context: { cellId: "cell", toolCallId: id, cwd: ".", signal: outer } });
const target: CodeModeTool = { name: "write", description: "fixture", effect: "write", approval: "user",
	parameters: Type.Object({ value: Type.Integer() }), prepare: (input) => ({ value: Number((input as { value: unknown }).value) }),
	invoke: async () => ({ value: {} }) };

function legacy(pi: ExtensionAPI, extra = {}) {
	const providers: CodeModeProvider[] = [], policies: CodeModePolicy[] = [];
	pi.events.emit(DISCOVER, { version: 1, ...extra,
		provider: (value: CodeModeProvider) => providers.push(value), policy: (value: CodeModePolicy) => policies.push(value) });
	return { tools: providers.flatMap((p) => p.tools), policies };
}
function negotiate(pi: ExtensionAPI, features: string[]) {
	const hello: ConsumerHello = { protocol: 2, instanceId: "fixture", generation: 1, features,
		limits: { resultBytes: 65536, callsPerCell: 32, maxCells: 4 } };
	const offers: DiscoveryOffer[] = [];
	const receipts: DiscoveryReceipt[] = [];
	pi.events.emit(DISCOVER_V2, { hello, offer(value: DiscoveryOffer) {
		offers.push(value); receipts.push({ registration: value.registration, consumer: hello });
		return { status: "compatible" };
	} });
	return { hello, offers, receipts };
}

test("ABI gate: an old consumer ignoring approval never receives its executable closure", () => {
	const pi = { events: createEventBus() } as unknown as ExtensionAPI;
	const registration = registerCodeModeTools(pi, { id: "owner", tools: [target, { ...target, name: "safe", approval: undefined }] });
	assert.deepEqual(legacy(pi).tools.map((tool) => tool.name), ["safe"]);
	const incapable = negotiate(pi, []);
	assert.equal(incapable.offers.length, 0);
	assert.deepEqual(legacy(pi).tools.map((tool) => tool.name), ["safe"]);
	const capable = negotiate(pi, ["approval/1"]);
	assert.equal(capable.offers.length, 1);
	assert.deepEqual(legacy(pi, { consumer: capable.hello, receipts: capable.receipts }).tools, []);
	assert.deepEqual(legacy(pi, { consumer: { ...capable.hello }, receipts: capable.receipts }).tools.map((tool) => tool.name), ["safe"]);
	const catalog = collect(pi);
	assert.deepEqual(catalog.tools.map((tool) => tool.name), ["owner__write", "owner__safe"]);
	registration.dispose();
	assert.equal(collect(pi).tools.length, 0);
});

test("ABI gate: mandatory approval policy gives old consumers a deny guard, not an omitted policy", async () => {
	const pi = { events: createEventBus() } as unknown as ExtensionAPI;
	registerCodeModePolicy(pi, { id: "guard", approval: "user" });
	const old = legacy(pi);
	let effects = 0;
	// Model the initial ABI: knows before(), ignores later approval metadata.
	for (const policy of old.policies) {
		const result = await policy.before?.(call("write"));
		if (result?.block) continue;
		effects++;
	}
	assert.equal(old.policies.length, 1);
	assert.equal(effects, 0);
	const catalog = collect(pi);
	const bridge = new ToolBridge([{ ...target, name: "safe", approval: undefined,
		invoke: async () => { effects++; return { value: {} }; } }], catalog.policies,
		"cell", ".", signal(), () => undefined, () => {}, () => {}, { approvals: [] });
	await assert.rejects(bridge.invoke("safe", { value: 1 }, "id", signal()), /approval/i);
	assert.equal(effects, 0);
	const accepted = negotiate(pi, ["approval/1"]);
	assert.equal(legacy(pi, { consumer: accepted.hello, receipts: accepted.receipts }).policies.length, 0);
	assert.equal(legacy(pi, { consumer: accepted.hello, receipts: accepted.receipts.map((r) => ({
		...r, registration: { ...r.registration },
	})) }).policies.length, 1, "copied registration is not the producer's exact receipt");
});

test("ABI gate: safe to approval-required refresh revokes before publishing and rejects old receipts", () => {
	const pi = { events: createEventBus() } as unknown as ExtensionAPI;
	const registration = registerCodeModeTools(pi, { id: "owner", tools: [{ ...target, approval: undefined }] });
	const old = negotiate(pi, ["approval/1"]);
	const snapshots: string[][] = [];
	pi.events.on(CHANGED, () => snapshots.push(collect(pi).tools.map((tool) => tool.approval ?? "safe")));
	registration.refresh([target]);
	assert.deepEqual(snapshots, [[], ["user"]]);
	assert.deepEqual(legacy(pi, { consumer: old.hello, receipts: old.receipts }).tools, []);
	registration.refresh([{ ...target, approval: undefined }]);
	assert.equal(legacy(pi, { consumer: old.hello, receipts: old.receipts }).tools.length, 1);
	assert.equal(negotiate(pi, ["approval/1"]).offers[0].registration.revision, 3);
});

test("ABI gate: duplicate and incompatible global policy offers fail even when Pi catches listener errors", () => {
	const pi = { events: createEventBus() } as unknown as ExtensionAPI;
	pi.events.on(DISCOVER_V2, (request: unknown) => {
		const { offer } = request as { offer(value: DiscoveryOffer): unknown };
		offer({ kind: "policy", registration: { owner: "guard", instanceId: "guard", revision: 1 },
			requires: ["unknown/1"], policy: { id: "guard", before() {} } });
	});
	assert.throws(() => collect(pi), /incompatible/);
});

test("approvals: FIFO, queued cancellation, active cancellation retains the UI slot", async () => {
	const queue = new ApprovalQueue();
	const seen: string[] = [];
	const finish: ((value: boolean) => void)[] = [];
	const provider = { id: "user", approve: (value: PolicyCall) => {
		seen.push(value.name); return new Promise<boolean>((resolve) => finish.push(resolve));
	} };
	const a = new AbortController(), b = new AbortController();
	const first = queue.request(provider, call("a", a.signal));
	const second = queue.request(provider, call("b", b.signal));
	const rejected = assert.rejects(second);
	const third = queue.request(provider, call("c"));
	await tick(); b.abort(); await rejected; a.abort();
	assert(queue.stalled);
	assert.deepEqual(seen, ["a"]);
	const firstRejected = assert.rejects(first);
	finish[0](true); await firstRejected; await tick();
	assert.deepEqual(seen, ["a", "c"]);
	finish[1](true); await third; await tick();
	assert.equal(queue.pending, 0);
});

test("approvals: explicit discovery, duplicates and approval-only policies", () => {
	const pi = { events: createEventBus() } as unknown as ExtensionAPI;
	const off = registerCodeModeApproval(pi, { id: "user", approve: () => true });
	const policy = registerCodeModePolicy(pi, { id: "guard", approval: "user" });
	assert.equal(collect(pi).approvals?.length, 1);
	assert.equal(collect(pi).policies[0].approval, "user");
	const duplicate = registerCodeModeApproval(pi, { id: "user", approve: () => true });
	assert.throws(() => collect(pi), /duplicate/);
	duplicate(); off(); policy();
	assert.deepEqual(collect(pi).approvals, []);
});

test("approvals: builtin user denies headless and passes the invocation signal to Pi UI", async () => {
	const pi = { events: createEventBus(), registerFlag() {}, registerCommand() {}, on() {} } as unknown as ExtensionAPI;
	extension(pi);
	const provider = collect(pi).approvals!.find((item) => item.id === "user")!;
	await assert.rejects(Promise.resolve().then(() => provider.approve(call("headless"))), /interactive UI/);
	const value = call("ui");
	let shown = false;
	const uiCall: PolicyCall = { ...value, context: { ...value.context, pi: {
		hasUI: true, ui: { confirm: async (_title: string, message: string, options: { signal: AbortSignal }) => {
			shown = true; assert.equal(options.signal, value.context.signal);
			assert.match(message, /SHA256/); return false;
		} },
	} as never } };
	assert.equal(await provider.approve(uiCall), false); assert(shown);
});

test("approvals: frozen final args, dedup, fail-closed and no worker held by approval", async () => {
	let approve!: (value: boolean) => void;
	let approvedInput: unknown, invokedInput: unknown, effects = 0;
	const approved = { ...target, invoke: async (input: unknown) => { effects++; invokedInput = input; return { value: {} }; } };
	const make = (providers: { id: string; approve(call: PolicyCall): Promise<boolean> | boolean }[]) =>
		new ToolBridge([approved], [{ id: "guard", approval: "user" }], "cell", ".", signal(), () => undefined, () => {}, () => {}, { approvals: providers });
	for (const providers of [[], [{ id: "user", approve: () => false }], [{ id: "user", approve: () => { throw Error("broken"); } }]]) {
		await assert.rejects(make(providers).invoke("write", { value: "1" }, "id", signal()));
	}
	assert.equal(effects, 0);
	let prompts = 0;
	const bridge = new ToolBridge([approved, { ...target, name: "free", approval: undefined, invoke: async () => ({ value: "free" }) }], [],
		"cell", ".", signal(), () => undefined, () => {}, () => {}, { approvals: [{ id: "user", approve: (value) => {
			prompts++; approvedInput = value.input; assert(Object.isFrozen(value.input));
			assert.deepEqual(value.input, { value: 1 }); return new Promise<boolean>((resolve) => { approve = resolve; });
		} }] });
	const pending = bridge.invoke("write", { value: "1" }, "a", signal());
	await tick(); assert.equal(bridge.pendingApprovals, 1);
	assert.equal(await bridge.invoke("free", { value: "2" }, "b", signal()), "free");
	approve(true); await pending;
	assert.equal(invokedInput, approvedInput); assert.equal(prompts, 1);
	let dedup = 0;
	await make([{ id: "user", approve: () => { dedup++; return true; } }]).invoke("write", { value: 3 }, "c", signal());
	assert.equal(dedup, 1);
});

test("approvals: stale approval cannot execute; positive observations hold, cancellation consumes nothing", async () => {
	let approve!: (value: boolean) => void, effects = 0;
	const cell = new Cell(5000, async (current) => {
		current.bridge = new ToolBridge([{ ...target, invoke: async () => { effects++; return { value: {} }; } }], [],
			current.id, ".", current.controller.signal, () => undefined, () => {}, () => {},
			{ approvals: [{ id: "user", approve: () => new Promise<boolean>((resolve) => { approve = resolve; }) }] });
		await current.bridge.invoke("write", { value: 1 }, "a", current.controller.signal);
		return "completed";
	});
	await tick();
	assert.equal((await cell.observe(0, 8192)).state, "awaiting_approval");
	const observer = new AbortController();
	let observed = false;
	const pending = cell.observe(1, 8192, observer.signal).then((value) => { observed = true; return value; });
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(observed, false);
	observer.abort(); await assert.rejects(pending);
	cell.cancel("refresh");
	assert.equal((await cell.observe(0, 8192)).state, "terminating");
	approve(true); await cell.finished;
	assert.equal(effects, 0);
});
