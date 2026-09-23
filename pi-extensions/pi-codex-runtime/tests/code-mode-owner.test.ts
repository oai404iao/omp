import assert from "node:assert/strict";
import { test } from "node:test";
import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { codeModeOwner, disposeCodeModeOwner, type OwnerState } from "../src/code-mode-owner.js";

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
	return { pi, tool, expected, info, control, get factory() { return factory; }, setFactory(value: typeof factory) { factory = value; },
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
	f.get();
	f.expected.parameters = structuredClone(f.expected.parameters);
	assert.equal(f.get(), undefined);
	assert.equal(f.tool.codeModeOwner?.replaced, true);
	assert.equal(f.tool.codeModeOwner?.control, undefined);
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

for (const replacement of ["sdk", "builtin", "schema", "missing", "unregistered"]) test(`owner retirement retries after ${replacement} replacement`, () => {
	const f = fixture();
	const old = f.get()!;
	let attempts = 0;
	old.dispose = () => { if (++attempts <= 2) throw new Error("restore failed"); };
	f.setFactory(undefined);
	assert.throws(f.get, /restore failed/);
	if (replacement === "sdk" || replacement === "builtin") f.info.sourceInfo.source = replacement;
	else if (replacement === "schema") f.info.parameters = structuredClone(f.info.parameters);
	else if (replacement === "missing") f.pi.getAllTools = () => [];
	else f.tool.registered = false;
	assert.throws(f.get, /restore failed/);
	assert.equal(f.get(), undefined);
	assert.equal(attempts, 3);
	assert.equal(f.tool.codeModeOwner?.pendingDispose, undefined);
});

test("owner shutdown drains an invalid control without rediscovery and prevents reentrant creation", () => {
	const f = fixture();
	let attempts = 0;
	const invalid = { ...f.control(), reconcile: undefined, dispose() {
		assert.equal(f.get(), undefined);
		if (++attempts === 1) throw new Error("cleanup failed");
	} };
	f.setFactory({ version: 1, create: () => invalid as never });
	assert.throws(f.get, /Invalid/);
	assert.throws(() => disposeCodeModeOwner(f.tool), /cleanup failed/);
	disposeCodeModeOwner(f.tool);
	assert.equal(f.get(), undefined);
	assert.equal(attempts, 2);
});

for (const phase of ["discovery", "dispose", "create"] as const) for (const change of ["shutdown", "replacement"] as const) {
	test(`owner transition rechecks ${change} during ${phase} callbacks`, () => {
		const f = fixture();
		const old = f.get()!;
		let creates = 0, releases = 0;
		const invalidate = () => {
			if (change === "shutdown") disposeCodeModeOwner(f.tool);
			else f.info.parameters = structuredClone(f.info.parameters);
		};
		if (phase === "dispose") old.dispose = invalidate;
		if (phase === "discovery") f.pi.events.on("@oai404iao/pi-code-mode:direct-owner/v1", invalidate);
		f.setFactory({ version: 1, create() {
			creates++;
			if (phase === "create") invalidate();
			return { ...f.control(), dispose() { releases++; } };
		} });
		assert.equal(f.get(), undefined);
		assert.equal(creates, phase === "create" ? 1 : 0);
		assert.equal(releases, creates);
		assert.equal(f.tool.codeModeOwner?.control, undefined);
	});
}
