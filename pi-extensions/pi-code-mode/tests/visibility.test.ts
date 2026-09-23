import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { createEventBus, type ExtensionAPI, type ToolInfo } from "@earendil-works/pi-coding-agent";
import { createCodeModeDirectBinding, type CodeModeTool } from "../src/contributions.ts";
import { Visibility, visibilityMode } from "../src/visibility.ts";
import { installOwnerFactory } from "../src/owner-factory.ts";

const sourcePath = "/fixture/owner.ts";
const info = (name = "lookup"): ToolInfo => ({
	name, description: "direct lookup", parameters: Type.Object({}),
	sourceInfo: { path: sourcePath, source: "test", scope: "temporary", origin: "top-level" },
});
function fixture(active = ["read", "lookup", "bash"]) {
	let definitions = [info()];
	let writes = 0;
	const handlers = new Map<string, Set<() => void>>();
	const pi = {
		events: createEventBus(),
		on(name: string, handler: () => void) {
			if (!handlers.has(name)) handlers.set(name, new Set());
			handlers.get(name)!.add(handler);
			return () => { handlers.get(name)!.delete(handler); };
		},
		getAllTools: () => definitions,
		getActiveTools: () => active.slice(),
		setActiveTools: (next: string[]) => { active = next.slice(); writes++; },
	} as unknown as ExtensionAPI;
	const owner = createCodeModeDirectBinding(pi, { name: "lookup", sourcePath });
	const tool: CodeModeTool = { name: "fixture__lookup", description: "nested", parameters: Type.Object({}),
		effect: "read", direct: owner.binding, invoke: async () => ({ value: "ok" }) };
	return {
		pi, owner, tool, view: new Visibility(),
		get active() { return active; }, get writes() { return writes; },
		foreign(next: string[]) { active = next; },
		replace(next: ToolInfo[]) { definitions = next; },
		emit(name: string) { for (const handler of handlers.get(name) ?? []) handler(); },
	};
}

test("visibility: mixed is default, only is rejected, construction/mixed make no changes", () => {
	assert.equal(visibilityMode(undefined), "mixed");
	assert.equal(visibilityMode("hide-bridged"), "hide-bridged");
	for (const value of ["only", "", true]) assert.throws(() => visibilityMode(value), /strict only/);
	const f = fixture();
	f.view.sync("mixed", [f.tool]);
	assert.equal(f.writes, 0);
});

test("visibility: tree loadouts cannot undo an owned restoration, but explicit inactivity and replacements win", () => {
	for (const action of ["restore", "inactive", "replacement", "disposed", "cancelled"] as const) {
		const f = fixture();
		f.view.sync("hide-bridged", [f.tool]);
		f.view.release();
		if (action === "inactive") f.owner.setActive(false);
		f.emit("session_before_tree");
		if (action === "replacement") f.replace([{ ...info(), description: "new owner definition" }]);
		if (action === "disposed") f.owner.dispose();
		if (action === "cancelled") {
			f.owner.setActive(false);
			f.emit("session_before_tree");
		}
		f.foreign(["read", "bash", "new_foreign_tool"]);
		f.emit("session_tree");
		assert.equal(f.active.includes("lookup"), action === "restore");
		assert(f.active.includes("new_foreign_tool"));
	}
});

test("visibility: restore only removed names into live state, never replay the old active set", () => {
	const f = fixture();
	f.view.sync("hide-bridged", [f.tool]);
	assert.deepEqual(f.active, ["read", "bash"]);
	f.foreign(["bash", "unrelated_new"]);
	f.view.sync("mixed", []);
	assert.deepEqual(f.active, ["bash", "lookup", "unrelated_new"]);
	f.view.release();
	assert.equal(f.writes, 2, "idempotent release");
});

test("visibility: initially inactive stays inactive; owner's latest activation intent wins", () => {
	const f = fixture(["read"]);
	f.view.sync("hide-bridged", [f.tool]); f.view.release();
	assert.deepEqual(f.active, ["read"]);
	f.view.sync("hide-bridged", [f.tool]);
	f.owner.setActive(true);
	assert.deepEqual(f.active, ["read"]);
	f.view.release();
	assert.deepEqual(f.active, ["read", "lookup"]);
	f.view.sync("hide-bridged", [f.tool]);
	f.owner.setActive(false);
	f.view.release();
	assert.deepEqual(f.active, ["read"]);
});

test("visibility: cooperating auto-enable and registry refresh stay suppressed without a global lock", () => {
	const f = fixture();
	f.view.sync("hide-bridged", [f.tool]);
	f.owner.setActive(true); f.owner.setActive(true);
	assert.deepEqual(f.active, ["read", "bash"]);
	f.foreign([...f.active, "lookup"]); // Pi registerTool/allowlist can re-add it
	f.owner.reconcile();
	assert.deepEqual(f.active, ["read", "bash"]);
	f.view.release();
	assert(f.active.includes("lookup"));
});

test("visibility: an initially absent direct registration can cooperate when it appears", () => {
	const f = fixture(["read"]);
	f.replace([]);
	f.view.sync("hide-bridged", [f.tool]);
	assert.deepEqual(f.view.names, []);
	f.pi.events.on("@oai404iao/pi-code-mode:visibility/v1", () => f.view.sync("hide-bridged", [f.tool]));
	f.replace([info()]); f.foreign(["read", "lookup"]);
	f.owner.reconcile();
	assert.deepEqual(f.view.names, ["lookup"]);
	assert.deepEqual(f.active, ["read"]);
});

test("visibility: metadata replacement or source-owner replacement is never hidden/restored by old receipts", () => {
	for (const changed of [{ ...info(), description: "replacement" }, { ...info(), sourceInfo: { ...info().sourceInfo, path: "/another.ts" } }]) {
		const f = fixture();
		f.view.sync("hide-bridged", [f.tool]);
		f.replace([changed]);
		f.view.sync("hide-bridged", [f.tool]);
		assert.deepEqual(f.view.names, []);
		assert.deepEqual(f.active, ["read", "bash"], "must not activate a replacement");
		f.foreign(["read", "lookup"]);
		f.view.sync("hide-bridged", [f.tool]);
		assert.deepEqual(f.active, ["read", "lookup"], "must not hide a replacement");
	}
});

test("visibility: builtins, SDK tools, wrong source and reserved names cannot be claimed", () => {
	for (const source of ["builtin", "sdk"]) {
		const f = fixture();
		f.replace([{ ...info(), sourceInfo: { ...info().sourceInfo, source } }]);
		f.view.sync("hide-bridged", [f.tool]);
		assert.equal(f.writes, 0);
	}
	const f = fixture();
	for (const name of ["exec", "wait", "bad name"]) assert.throws(() => createCodeModeDirectBinding(f.pi, { name, sourcePath }));
});

test("visibility: duplicate claims fail before new hiding, rolling back only existing receipts", () => {
	const f = fixture();
	f.view.sync("hide-bridged", [f.tool]);
	f.foreign([...f.active, "new"]);
	assert.throws(() => f.view.sync("hide-bridged", [f.tool, { ...f.tool, name: "another__lookup" }]), /duplicate/);
	assert.deepEqual(f.active, ["read", "lookup", "bash", "new"]);
	assert.deepEqual(f.view.names, []);
});

test("visibility: owner acquisition failures roll back earlier acquired leases", () => {
	const f = fixture();
	const bad = { ...f.tool, name: "another", direct: { version: 1 as const, name: "bad", acquire() { throw new Error("owner failed"); } } };
	assert.throws(() => f.view.sync("hide-bridged", [f.tool, bad]), /owner failed/);
	assert.deepEqual(f.active, ["read", "lookup", "bash"]);
	assert.deepEqual(f.view.names, []);
});

test("visibility: disposing an owner releases once; stale handles cannot change replacement state", () => {
	const f = fixture();
	f.view.sync("hide-bridged", [f.tool]);
	f.owner.dispose(); f.owner.dispose(); f.view.release();
	assert.deepEqual(f.active, ["read", "lookup", "bash"]);
	f.foreign(["new"]);
	assert.equal(f.owner.setActive(true), false);
	assert.equal(f.owner.reconcile(), false);
	f.view.sync("hide-bridged", [f.tool]);
	assert.deepEqual(f.active, ["new"]);
});

test("visibility: a failed restoration keeps its receipt and can be retried", () => {
	const f = fixture();
	f.view.sync("hide-bridged", [f.tool]);
	const write = f.pi.setActiveTools;
	let fail = true;
	f.pi.setActiveTools = (names) => {
		if (fail) { fail = false; throw new Error("transient restore failure"); }
		write(names);
	};
	assert.throws(() => f.view.release(), /failed to release/);
	assert.deepEqual(f.view.names, ["lookup"]);
	f.view.release();
	assert.deepEqual(f.active, ["read", "lookup", "bash"]);
	assert.deepEqual(f.view.names, []);
});

test("visibility: explicit intent and live leases override both historical loadouts", () => {
	for (const intended of [true, false]) for (const leased of [true, false]) {
		const f = fixture();
		f.owner.setActive(intended);
		if (leased) f.view.sync("hide-bridged", [f.tool]);
		for (const historical of [true, false]) {
			f.emit("session_before_tree");
			f.foreign(["foreign", ...(historical ? ["lookup"] : [])]);
			f.emit("session_tree");
			assert.equal(f.active.includes("lookup"), intended && !leased);
			assert(f.active.includes("foreign"));
			assert.equal(f.owner.activeIntent, intended);
		}
		f.view.release();
		assert.equal(f.active.includes("lookup"), intended);
	}
});

test("visibility: failed owner disposal keeps tree protection and refuses reacquisition until retry", () => {
	const f = fixture();
	f.owner.setActive(true);
	const lease = f.owner.binding.acquire()!;
	const write = f.pi.setActiveTools;
	f.pi.setActiveTools = () => { throw new Error("restore failed"); };
	assert.throws(() => f.owner.dispose(), /restore failed/);
	f.pi.setActiveTools = write;
	f.emit("session_before_tree");
	f.foreign(["lookup", "foreign"]);
	f.emit("session_tree");
	assert.deepEqual(f.active, ["foreign"]);
	assert.equal(f.owner.binding.acquire(), undefined);
	assert.equal(f.owner.setActive(false), false);
	f.owner.dispose();
	assert(f.active.includes("lookup"));
	f.foreign(["foreign"]);
	lease.release();
	f.emit("session_tree");
	assert.deepEqual(f.active, ["foreign"], "disposed handlers and stale receipts stay inert");
});

function ownerFactory(pi: ExtensionAPI) {
	let factory!: { create(pi: ExtensionAPI, options: { name: string; sourcePath: string }): ReturnType<typeof createCodeModeDirectBinding> };
	pi.events.emit("@oai404iao/pi-code-mode:direct-owner/v1", { version: 1, accept(value: typeof factory) { factory = value; } });
	return factory;
}

test("owner factory: budget counts live controls, not lifetime allocations", () => {
	const f = fixture();
	const close = installOwnerFactory(f.pi);
	const factory = ownerFactory(f.pi);
	for (let i = 0; i < 100; i++) factory.create(f.pi, { name: "lookup", sourcePath }).dispose();
	const live = Array.from({ length: 64 }, () => factory.create(f.pi, { name: "lookup", sourcePath }));
	assert.throws(() => factory.create(f.pi, { name: "lookup", sourcePath }), /full/);
	live[0].dispose();
	factory.create(f.pi, { name: "lookup", sourcePath });
	close(); close();
	assert.throws(() => factory.create(f.pi, { name: "lookup", sourcePath }), /disposed/);
});

test("owner factory: shutdown failure is retryable and blocks synchronous acquisition", () => {
	const f = fixture();
	const close = installOwnerFactory(f.pi);
	const factory = ownerFactory(f.pi);
	const control = factory.create(f.pi, { name: "lookup", sourcePath });
	control.binding.acquire();
	const write = f.pi.setActiveTools;
	f.pi.setActiveTools = () => { throw new Error("restore failed"); };
	assert.throws(close, /owner cleanup failed/);
	assert.equal(ownerFactory(f.pi), undefined);
	assert.throws(() => factory.create(f.pi, { name: "lookup", sourcePath }), /closing/);
	f.pi.setActiveTools = write;
	let reentries = 0;
	f.pi.events.on("@oai404iao/pi-code-mode:visibility/v1", () => {
		reentries++;
		assert.throws(() => factory.create(f.pi, { name: "lookup", sourcePath }), /closing/);
		close();
	});
	close();
	assert.equal(reentries, 1);
	assert(f.active.includes("lookup"));
});

test("owner factory: all controls close admission before any notification and cleanup continues after failure", () => {
	const f = fixture();
	const close = installOwnerFactory(f.pi);
	const factory = ownerFactory(f.pi);
	const first = factory.create(f.pi, { name: "lookup", sourcePath });
	const second = factory.create(f.pi, { name: "lookup", sourcePath });
	first.binding.acquire();
	const write = f.pi.setActiveTools;
	let checks = 0;
	f.pi.setActiveTools = () => {
		checks++;
		assert.equal(second.binding.acquire(), undefined, "not-yet-disposed control must already be closed");
		throw new Error("first restore failed");
	};
	assert.throws(close, AggregateError);
	assert.equal(checks, 1);
	assert.equal(second.activeIntent, undefined, "independent cleanup must not be skipped");
	assert.equal(second.binding.acquire(), undefined);
	f.pi.setActiveTools = write;
	close();
	assert.equal(first.activeIntent, undefined);
});
