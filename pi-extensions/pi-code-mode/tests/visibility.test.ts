import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { createEventBus, type ExtensionAPI, type ToolInfo } from "@earendil-works/pi-coding-agent";
import { createCodeModeDirectBinding, type CodeModeTool } from "../src/contributions.ts";
import { Visibility, visibilityMode } from "../src/visibility.ts";

const sourcePath = "/fixture/owner.ts";
const info = (name = "lookup"): ToolInfo => ({
	name, description: "direct lookup", parameters: Type.Object({}),
	sourceInfo: { path: sourcePath, source: "test", scope: "temporary", origin: "top-level" },
});
function fixture(active = ["read", "lookup", "bash"]) {
	let definitions = [info()];
	let writes = 0;
	const pi = {
		events: createEventBus(),
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
