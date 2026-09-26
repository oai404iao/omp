import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { ToolBridge } from "../src/bridge.ts";
import { Scheduler } from "../src/scheduler.ts";
import { unsettledEffect } from "../src/errors.ts";
import type { CodeModeApproval, CodeModePolicy, CodeModeTool, CompletionReceipt } from "../src/contributions.ts";

function deferred<T>() {
	let resolve!: (value: T) => void, reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	void promise.catch(() => {});
	return { promise, resolve, reject };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const signal = () => new AbortController().signal;
const tool: CodeModeTool = { name: "effect", description: "fixture", parameters: Type.Object({}), effect: "write",
	async invoke() { return { value: "private" }; } };
const foreignFailure = () => ({ code: "PI_CODE_MODE_UNSETTLED_EFFECT", version: 1, message: "owner cleanup unconfirmed" });

for (const stage of ["prepare", "before"] as const) {
	test(`settlement: synchronous ${stage} fatal closes shared admission before invoke returns`, async () => {
		const scheduler = new Scheduler();
		let effects = 0, fatal = 0;
		const fail = () => { throw foreignFailure(); };
		const first = new ToolBridge([{ ...tool, ...(stage === "prepare" ? { prepare: fail } : {}) }],
			stage === "before" ? [{ id: "guard", before: fail }] : [], "first", ".", signal(),
			() => undefined, () => {}, () => { fatal++; }, { scheduler });
		const sibling = new ToolBridge([{ ...tool, async invoke() { effects++; return { value: null }; } }],
			[], "sibling", ".", signal(), () => undefined, () => {}, () => {}, { scheduler });
		const bad = first.invoke("effect", {}, "bad", signal());
		assert.equal(fatal, 1, "fatal handling is synchronous, not a later promise catch");
		const next = sibling.invoke("effect", {}, "next", signal());
		await Promise.all([assert.rejects(bad, /cleanup unconfirmed/), assert.rejects(next, /cleanup unconfirmed/)]);
		await first.settled();
		assert.equal(effects, 0);
		assert.equal(fatal, 1, "nested catches do not report the same fatal twice");
		assert(first.unsettled);
	});
}

for (const stage of ["before", "approval"] as const) {
	for (const cancelled of [false, true]) {
		test(`settlement: late ${stage} fatal stops queued sibling work (cancelled=${cancelled})`, async () => {
			const scheduler = new Scheduler();
			const head = deferred<void>(), entered = deferred<void>(), cleanup = deferred<boolean>();
			const blocker = scheduler.run(true, signal(), () => head.promise);
			const controller = new AbortController();
			let effects = 0, fatal = 0;
			const approval: CodeModeApproval = { id: "user", approve() {
				assert.equal(this, approval, "the owner's receiver is preserved");
				entered.resolve();
				return cleanup.promise;
			} };
			const first = new ToolBridge([{ ...tool, ...(stage === "approval" ? { approval: "user" } : {}) }],
				stage === "before" ? [{ id: "guard", async before() { entered.resolve(); await cleanup.promise; } }] : [],
				"first", ".", signal(), () => undefined, () => {}, () => { fatal++; },
				{ scheduler, approvals: [approval] });
			const sibling = new ToolBridge([{ ...tool, async invoke() { effects++; return { value: null }; } }],
				[], "sibling", ".", signal(), () => undefined, () => {}, () => {}, { scheduler });
			const bad = assert.rejects(first.invoke("effect", {}, "bad", controller.signal));
			await entered.promise;
			const next = assert.rejects(sibling.invoke("effect", {}, "queued", signal()), /cleanup unconfirmed/);
			if (cancelled) controller.abort(new Error("cancel fixture"));
			try {
				cleanup.reject(foreignFailure());
				await bad;
				await first.settled();
				await next;
				assert.equal(effects, 0);
				assert.equal(fatal, 1);
				assert(first.unsettled);
			} finally { cleanup.resolve(true); head.resolve(); await blocker; }
		});
	}
}

test("settlement: synchronous approval fatal aborts the queued dialog before it can run", async () => {
	const controller = new AbortController();
	let prompts = 0, effects = 0, fatal = 0;
	const bridge = new ToolBridge([{ ...tool, approval: "user", async invoke() { effects++; return { value: null }; } }],
		[], "cell", ".", controller.signal, () => undefined, () => {}, () => { fatal++; },
		{ approvals: [{ id: "user", approve() { prompts++; throw foreignFailure(); } }] });
	const results = await Promise.allSettled([
		bridge.invoke("effect", {}, "first", controller.signal),
		bridge.invoke("effect", {}, "second", controller.signal),
	]);
	assert(results.every((result) => result.status === "rejected"));
	assert.equal(prompts, 1);
	assert.equal(effects, 0);
	assert.equal(fatal, 1);
});

for (const stage of ["before", "after"] as const) {
	test(`settlement: ${stage} cancellation rejects delivery but retains cleanup and receipts`, async () => {
		const scheduler = new Scheduler(), controller = new AbortController();
		const entered = deferred<void>(), cleanup = deferred<void>();
		let effects = 0, siblingEffects = 0, nextPolicy = 0, fatal = 0, settled = false;
		const receipts: CompletionReceipt[] = [];
		const policy: CodeModePolicy = stage === "before"
			? { id: "first", async before() { entered.resolve(); await cleanup.promise; } }
			: { id: "first", async after(_call, value) { entered.resolve(); await cleanup.promise; return value; } };
		const bridge = new ToolBridge([{ ...tool, async invoke() { effects++; return { value: "private" }; } }],
			[policy, { id: "second", before() { nextPolicy++; }, after(_call, value) { nextPolicy++; return value; } }],
			"cell", ".", signal(), () => undefined, () => {}, () => { fatal++; },
			{ scheduler, observers: [{ id: "audit", complete(receipt) { receipts.push(receipt); } }] });
		const sibling = new ToolBridge([{ ...tool, async invoke() { siblingEffects++; return { value: null }; } }],
			[], "sibling", ".", signal(), () => undefined, () => {}, () => {}, { scheduler });
		const delivery = assert.rejects(bridge.invoke("effect", {}, "first", controller.signal), /cancel fixture/);
		await entered.promise;
		const next = stage === "after" ? sibling.invoke("effect", {}, "next", signal()) : undefined;
		const lifetime = bridge.settled().then(() => { settled = true; });
		try {
			controller.abort(new Error("cancel fixture"));
			await delivery;
			await tick();
			assert.equal(settled, false);
			assert.equal(receipts.length, 0);
			assert.equal(bridge.traces[0].settledAt, undefined);
			assert.equal(siblingEffects, 0, "exclusive after-policy still owns its scheduler slot");
			cleanup.resolve();
			await lifetime;
			await next;
			await tick();
			assert.equal(effects, stage === "before" ? 0 : 1);
			assert.equal(nextPolicy, stage === "before" ? 0 : 1, "no policy/dispatch resumes from a late value");
			assert.equal(siblingEffects, stage === "before" ? 0 : 1);
			assert.equal(fatal, 0, "ordinary asynchronous cleanup does not poison the session");
			assert.equal(receipts.length, 1);
			assert(bridge.traces[0].settledAt);
		} finally { cleanup.resolve(); await lifetime; }
	});
}

test("settlement: late after-policy fatal is not lost behind cancellation or released to a sibling", async () => {
	const scheduler = new Scheduler(), controller = new AbortController();
	const entered = deferred<void>(), cleanup = deferred<never>();
	let effects = 0, fatal = 0;
	const bridge = new ToolBridge([tool], [{ id: "guard", after() { entered.resolve(); return cleanup.promise; } }],
		"first", ".", signal(), () => undefined, () => {}, () => { fatal++; }, { scheduler });
	const sibling = new ToolBridge([{ ...tool, async invoke() { effects++; return { value: null }; } }],
		[], "sibling", ".", signal(), () => undefined, () => {}, () => {}, { scheduler });
	const first = assert.rejects(bridge.invoke("effect", {}, "first", controller.signal), /cancel fixture/);
	await entered.promise;
	const next = assert.rejects(sibling.invoke("effect", {}, "next", signal()), /cleanup unconfirmed/);
	controller.abort(new Error("cancel fixture"));
	await first;
	cleanup.reject(unsettledEffect("owner cleanup unconfirmed"));
	await bridge.settled();
	await next;
	assert.equal(effects, 0);
	assert.equal(fatal, 1);
	assert(bridge.unsettled);
});

test("settlement: the real five-second policy timeout retains the exclusive lifetime", { timeout: 10000 }, async () => {
	const entered = deferred<void>(), cleanup = deferred<void>();
	const keepAlive = setTimeout(() => {}, 9000); // AbortSignal.timeout alone is unref'ed.
	let policySignal: AbortSignal | undefined, effects = 0, settled = false;
	const bridge = new ToolBridge([tool, { ...tool, name: "next", async invoke() { effects++; return { value: null }; } }],
		[{ id: "guard", async after(call, value) {
			if (call.name === "effect") { policySignal = call.context.signal; entered.resolve(); await cleanup.promise; }
			return value;
		} }], "cell", ".", signal(), () => undefined, () => {}, () => {});
	try {
		const first = assert.rejects(bridge.invoke("effect", {}, "first", signal()), /timeout/i);
		await entered.promise;
		const next = bridge.invoke("next", {}, "second", signal());
		const lifetime = bridge.settled().then(() => { settled = true; });
		await first;
		assert(policySignal?.aborted);
		assert.equal(settled, false);
		assert.equal(effects, 0);
		cleanup.resolve();
		await lifetime;
		await next;
		assert.equal(effects, 1);
		assert.equal(bridge.unsettled, undefined);
	} finally { cleanup.resolve(); clearTimeout(keepAlive); await bridge.settled(); }
});
