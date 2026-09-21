import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCodeModeTools, registerCodeModeObserver, type CodeModeTool } from "../src/contributions.ts";
import { registerPiBuiltinLs } from "../src/builtin-adapters.ts";
import inventory from "../examples/inventory.ts";
import { piSession, scratch } from "./helpers.ts";
import { Runtime } from "../src/runtime.ts";

const host = process.env.CODE_MODE_TEST_HOST;
assert(host, "CODE_MODE_TEST_HOST required; no silent interoperability skips");
process.env.XDG_STATE_HOME = await scratch("interop-host-state");

test("real Host: observer/presentation changes preserve live cells and store; executable refresh revokes both", { timeout: 30000 }, async (t) => {
	let pi!: ExtensionAPI;
	let registration!: ReturnType<typeof registerCodeModeTools>;
	let release!: () => void;
	let started!: () => void;
	let began = new Promise<void>((resolve) => { started = resolve; });
	const hold: CodeModeTool = { name: "hold", description: "hold", parameters: Type.Object({}), effect: "read", parallel: true,
		async invoke(_input, ctx) {
			await new Promise<void>((resolve, reject) => {
				const abort = () => reject(ctx.signal.reason);
				release = () => { ctx.signal.removeEventListener("abort", abort); resolve(); };
				ctx.signal.addEventListener("abort", abort, { once: true });
				if (ctx.signal.aborted) abort();
				started();
			});
			return { value: "released" };
		} };
	let hosts = 0;
	const create = Runtime.create;
	t.mock.method(Runtime, "create", async (...args: Parameters<typeof Runtime.create>) => { hosts++; return create(...args); });
	const f = await piSession(t, { host, grant: true, factoryFirst: true, tools: "fixture__hold", factory(api) {
		pi = api; registration = registerCodeModeTools(api, { id: "fixture", tools: [hold] });
	} });
	const call = async (name: string, args: object) => f.session.getToolDefinition(name)!.execute(
		"test", args, undefined, undefined, f.session.extensionRunner.createContext());
	const first = await call("exec", { code: 'text(await tools.fixture__hold({})); store("kept",42)', yield_time_ms: 0 });
	await began;
	const id = (first.details as { cellId: string }).cellId;
	const stop = registerCodeModeObserver(pi, { id: "audit", complete() {} });
	registration.refresh([{ ...hold, description: "new display" }], "presentation");
	stop();
	release();
	let completed = await call("wait", { cell_id: id, yield_time_ms: 10000 });
	while (!["completed", "failed", "terminated"].includes((completed.details as { state: string }).state))
		completed = await call("wait", { cell_id: id, yield_time_ms: 10000 });
	assert.equal((completed.details as { state: string }).state, "completed");
	const loaded = await call("exec", { code: 'text(load("kept"))', yield_time_ms: 10000 });
	assert.match(JSON.stringify(loaded.content), /42/);
	assert.equal(hosts, 1);

	began = new Promise<void>((resolve) => { started = resolve; });
	const old = await call("exec", { code: "text(await tools.fixture__hold({}))", yield_time_ms: 0 });
	await began;
	registration.refresh([hold]);
	await f.session.prompt("/code-mode protocol json");
	await assert.rejects(call("wait", { cell_id: (old.details as { cellId: string }).cellId }), /stale/);
	const cleared = await call("exec", { code: 'text(load("kept") === undefined ? "cleared" : "retained")', yield_time_ms: 10000 });
	assert.match(JSON.stringify(cleared.content), /cleared/);
	assert.equal(hosts, 2);
	assert.deepEqual(f.errors, []);
});

test("real Host: approved I3 pilots execute only via exact grants while inventory stays direct", { timeout: 20000 }, async (t) => {
	const f = await piSession(t, { host, grant: true, tools: "inventory__lookup,pi_builtin__ls", factoryFirst: true,
		factory(pi) { inventory(pi); registerPiBuiltinLs(pi); },
	});
	await writeFile(join(f.cwd, "pilot.txt"), "fixture");
	const result = await f.session.getToolDefinition("exec")!.execute("test", {
		code: 'text(await tools.inventory__lookup({name:"sample"})); text(await tools.pi_builtin__ls({path:".",limit:10}));',
		yield_time_ms: 10000,
	}, undefined, undefined, f.session.extensionRunner.createContext());
	assert.equal((result.details as { state: string }).state, "completed");
	assert.match(JSON.stringify(result.content), /example/);
	assert.match(JSON.stringify(result.content), /pilot.txt/);
	assert(f.session.getActiveToolNames().includes("inventory_lookup"));
	assert.deepEqual(f.errors, []);
});
