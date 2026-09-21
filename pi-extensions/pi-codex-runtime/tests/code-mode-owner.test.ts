import assert from "node:assert/strict";
import { test } from "node:test";
import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { codeModeOwner, type OwnerState } from "../src/code-mode-owner.js";

function fixture() {
	const expected = { parameters: { type: "object", properties: {} }, description: "Patch" };
	const info = { name: "apply_patch", ...expected,
		sourceInfo: { path: "/fixture/owner.ts", source: "test", scope: "temporary", origin: "top-level" } };
	const pi = { events: createEventBus(), getAllTools: () => [{ ...info }] } as unknown as ExtensionAPI;
	const tool: { registered: boolean; codeModeOwner?: OwnerState } = { registered: true };
	const control = () => ({
		binding: { version: 1 as const, name: "apply_patch", acquire: () => undefined },
		activeIntent: true, projectActive: (active: boolean) => active, reconcile: () => true, dispose() {},
	});
	let factory: { version: number; create(): ReturnType<typeof control> } | undefined = { version: 1, create: () => control() };
	pi.events.on("@oai404iao/pi-code-mode:direct-owner/v1", (value) => {
		if (factory) (value as { accept(value: unknown): void }).accept(factory);
	});
	return { pi, tool, expected, control, get factory() { return factory; }, setFactory(value: typeof factory) { factory = value; },
		get: () => codeModeOwner(pi, "apply_patch", tool, expected) };
}

test("owner client: failed disposal retains receipt and retries without reentrant acquisition", () => {
	const f = fixture();
	let attempts = 0;
	let creates = 0;
	const old = f.get()!;
	old.dispose = () => {
		attempts++;
		assert.equal(f.get(), undefined);
		if (attempts === 1) throw new Error("dispose failed");
	};
	const next = f.control();
	f.setFactory({ version: 1, create: () => { creates++; return next; } });
	assert.throws(f.get, /dispose failed/);
	assert.equal(f.tool.codeModeOwner?.control, old);
	assert.equal(creates, 0);
	assert.equal(f.get(), next);
	assert.equal(f.get(), next);
	assert.equal(attempts, 2);
	assert.equal(creates, 1);
});

test("owner client: failed creation retries without disposing the old receipt twice", () => {
	const f = fixture();
	let disposals = 0;
	let creates = 0;
	const old = f.get()!;
	old.dispose = () => { disposals++; };
	const next = f.control();
	f.setFactory({ version: 1, create: () => {
		assert.equal(f.get(), undefined);
		if (++creates === 1) throw new Error("create failed");
		return next;
	} });
	assert.throws(f.get, /create failed/);
	assert.equal(f.tool.codeModeOwner?.control, undefined);
	assert.equal(f.get(), next);
	assert.equal(disposals, 1);
	assert.equal(creates, 2);
});

test("owner client: schema clones are not registration evidence", () => {
	const f = fixture();
	const old = f.get();
	f.expected.parameters = structuredClone(f.expected.parameters);
	assert.equal(f.get(), undefined);
	assert.equal(f.tool.codeModeOwner?.replaced, true);
	assert.equal(f.tool.codeModeOwner?.control, old);
});

test("owner client: failed retirement retries when the original factory reappears", () => {
	const f = fixture();
	const factory = f.factory;
	const old = f.get()!;
	let attempts = 0;
	old.dispose = () => { if (++attempts === 1) throw new Error("restore failed"); };
	f.setFactory(undefined);
	assert.throws(f.get, /restore failed/);
	f.setFactory(factory);
	const next = f.get();
	assert(next);
	assert.notEqual(next, old);
	assert.equal(attempts, 2);
	assert.equal(f.get(), next);
});

test("owner client: invalid controls retain a cleanup receipt before replacement", () => {
	const f = fixture();
	let disposals = 0;
	const invalid = { ...f.control(), reconcile: undefined };
	invalid.dispose = () => { if (++disposals === 1) throw new Error("cleanup failed"); };
	f.setFactory({ version: 1, create: () => invalid as never });
	assert.throws(f.get, /Invalid/);
	const next = f.control();
	f.setFactory({ version: 1, create: () => next });
	assert.throws(f.get, /cleanup failed/);
	assert.equal(f.get(), next);
	assert.equal(disposals, 2);
});
