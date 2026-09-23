import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPiBuiltinLs } from "../src/builtin-adapters.ts";
import { collect } from "../src/catalog.ts";
import { CodeSession } from "../src/session.ts";
import { ToolBridge } from "../src/bridge.ts";
import inventory from "../examples/inventory.ts";
import { piSession, scratch } from "./helpers.ts";

test("Pi ls adapter is opt-in, separately granted, and never invokes or hides an installed override", async () => {
	const cwd = await scratch("builtin-ls");
	await writeFile(join(cwd, "visible.txt"), "fixture");
	await writeFile(join(cwd, ".hidden"), "fixture");
	await mkdir(join(cwd, "sub"));
	const outside = await scratch("builtin-ls-outside");
	await writeFile(join(outside, "outside.txt"), "fixture");
	const pi = {
		events: createEventBus(), on() {},
		getAllTools() { throw new Error("Must not resolve an installed SSH/remote override"); },
		setActiveTools() { throw new Error("Must not hide direct tools"); },
		registerTool() { throw new Error("Must not replace direct tools"); },
	} as unknown as ExtensionAPI;
	assert.deepEqual(collect(pi).tools, []);
	const registration = registerPiBuiltinLs(pi);
	const external = collect(pi);
	assert.deepEqual(external.tools.map((tool) => tool.name), ["pi_builtin__ls"]);
	const session = new CodeSession();
	try {
		await session.authorize(cwd, "/not-started");
		assert(!session.catalog(external).tools.some((tool) => tool.name === "pi_builtin__ls"));
		await session.revoke();
		await session.authorize(cwd, "/not-started", { write: false, process: false, tools: ["pi_builtin__ls"] });
		const catalog = session.catalog(external);
		const controller = new AbortController();
		const bridge = new ToolBridge(catalog.tools, [], "fixture", cwd, controller.signal, () => undefined, () => {}, () => {});
		const value = await bridge.invoke("pi_builtin__ls", {}, "one", controller.signal) as { text: string };
		assert.match(value.text, /visible.txt/);
		assert.match(value.text, /\.hidden/);
		assert.match(value.text, /sub\//);
		const limited = await bridge.invoke("pi_builtin__ls", { limit: 1 }, "two", controller.signal) as { text: string; entryLimitReached: number };
		assert.equal(limited.entryLimitReached, 1);
		assert.match(limited.text, /limit/);
		const externalValue = await bridge.invoke("pi_builtin__ls", { path: outside }, "three", controller.signal) as { text: string };
		assert.match(externalValue.text, /outside.txt/, "this is explicitly granted native authority, not local-root confinement");
		controller.abort();
		await assert.rejects(bridge.invoke("pi_builtin__ls", {}, "four", controller.signal));
	} finally { registration.dispose(); await session.revoke(true); }
});

test("standalone inventory loads without a Code Mode grant, keeps its direct entry, and shares business validation", async (t) => {
	const f = await piSession(t, { factory: inventory });
	assert(!f.session.getAllTools().some((tool) => tool.name === "exec"));
	const direct = f.session.getToolDefinition("inventory_lookup")!;
	assert(direct);
	const ctx = { cwd: f.cwd } as any;
	const result = await direct.execute("direct", { name: "sample" }, undefined, undefined, ctx);
	assert.match(JSON.stringify(result.content), /example/);
	const fake = { events: createEventBus(), registerTool() {}, on() {} } as unknown as ExtensionAPI;
	inventory(fake);
	const catalog = collect(fake);
	const nested = catalog.tools[0];
	assert.equal(nested.name, "inventory__lookup");
	const context = { cellId: "c", toolCallId: "t", cwd: ".", signal: new AbortController().signal };
	assert.deepEqual((await nested.invoke({ name: "sample" }, context)).value, { name: "sample", value: "example" });
	await assert.rejects(nested.invoke({ name: 1 }, context), /requires a name/);
	await assert.rejects(direct.execute("bad", { name: 1 }, undefined, undefined, ctx), /requires a name/);
});
