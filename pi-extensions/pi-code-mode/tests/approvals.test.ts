import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ApprovalQueue } from "../src/approvals.ts";
import { ToolBridge } from "../src/bridge.ts";
import { collect } from "../src/catalog.ts";
import { registerCodeModeApproval, registerCodeModePolicy, type CodeModeTool, type PolicyCall } from "../src/contributions.ts";
import { Cell } from "../src/cell.ts";
import extension from "../src/extension.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const signal = () => new AbortController().signal;
const call = (id: string, outer = signal()): PolicyCall => ({ name: id, effect: "write", input: {},
	context: { cellId: "cell", toolCallId: id, cwd: ".", signal: outer } });
const target: CodeModeTool = { name: "write", description: "fixture", effect: "write", approval: "user",
	parameters: Type.Object({ value: Type.Integer() }), prepare: (input) => ({ value: Number((input as { value: unknown }).value) }),
	invoke: async () => ({ value: {} }) };

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
