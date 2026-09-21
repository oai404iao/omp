import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { piSession } from "./helpers.ts";
import { scratch } from "./helpers.ts";
import extension from "../src/extension.ts";
import type { ExtensionAPI, ExtensionCommandContext, ToolDefinition, ToolInfo } from "@earendil-works/pi-coding-agent";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { EXEC_DESCRIPTION, WAIT_DESCRIPTION, execParameters, waitParameters } from "../src/public-tools.ts";
import { createCodeModeDirectBinding, registerCodeModeTools } from "../src/contributions.ts";

globalThis.fetch = async () => { throw new Error("Network forbidden in extension fixtures"); };

test("real Pi loader: disabled by default, no exec/provider takeover or implicit authorization", async (t) => {
	const f = await piSession(t);
	assert(!f.session.getAllTools().some((tool) => tool.name === "exec"));
	const direct = f.session.getActiveToolNames();
	await f.session.prompt("/code-mode on");
	assert.deepEqual(f.session.getActiveToolNames(), direct, "headless on cannot grant implicit read authority");
	assert.equal(f.session.model?.provider, "s1-fixture");
});

test("real Pi loader: explicit flags enable only JSON exec; off preserves direct tools", async (t) => {
	const f = await piSession(t, { host: "/fixture/not-executed-until-call", grant: true });
	const exec = f.session.getAllTools().find((tool) => tool.name === "exec");
	assert(exec);
	const schema = exec.parameters as { required: string[]; properties: Record<string, unknown> };
	assert.deepEqual(schema.required, ["code"]);
	assert.deepEqual(Object.keys(schema.properties), ["code", "yield_time_ms", "timeout_ms", "max_tokens"]);
	assert.deepEqual(f.session.getActiveToolNames().filter((name) => !["exec", "wait"].includes(name)), ["read", "bash", "edit", "write"]);
	assert(f.session.getActiveToolNames().includes("exec"));
	assert(f.session.getAllTools().some((tool) => tool.name === "wait"));
	await f.session.prompt("/code-mode off");
	assert(!f.session.getActiveToolNames().includes("exec"));
	assert.deepEqual(f.session.getActiveToolNames(), ["read", "bash", "edit", "write"]);
});

test("real Pi loader: existing exec tool is never replaced", async (t) => {
	const f = await piSession(t, {
		host: "/fixture", grant: true,
		factory: (pi) => pi.registerTool({
			name: "exec", label: "Existing", description: "Existing tool owner", parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "existing" }], details: {} }),
		}),
	});
	assert.equal(f.session.getAllTools().find((tool) => tool.name === "exec")?.description, "Existing tool owner");
	assert(f.errors.some((error) => error.includes("will not override")));
});

for (const name of ["exec", "wait"]) test(`real Pi loader: identical ${name} description cannot claim a foreign tool`, async (t) => {
	const description = name === "exec" ? EXEC_DESCRIPTION : WAIT_DESCRIPTION;
	const f = await piSession(t, {
		host: "/fixture", grant: true,
		factory: (pi) => pi.registerTool({
			name, label: "Foreign", description, parameters: structuredClone(name === "exec" ? execParameters : waitParameters),
			execute: async () => ({ content: [], details: {} }),
		}),
	});
	const active = f.session.getActiveToolNames();
	await f.session.prompt("/code-mode off");
	assert.deepEqual(f.session.getActiveToolNames(), active);
	assert(f.errors.some((error) => error.includes("will not override")));
});

test("registration identity: same-description replacements and cloned schemas are never refreshed or toggled", async () => {
	for (const replacement of ["schema", "source", "metadata"] as const) {
		let active: string[] = ["read"];
		const definitions = new Map<string, ToolDefinition>();
		const metadata = new Map<string, ToolInfo>();
		const handlers = new Map<string, (...args: any[]) => any>();
		const commands = new Map<string, { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }>();
		const cwd = await scratch("identity");
		const pi = {
			events: createEventBus(), registerFlag() {},
			getFlag: (name: string) => name === "code-mode-read-root" ? cwd : name === "code-mode-host" ? "/fixture" : undefined,
			on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); return () => handlers.delete(name); },
			registerCommand: (name: string, command: any) => commands.set(name, command),
			registerTool(tool: ToolDefinition) {
				definitions.set(tool.name, tool);
				metadata.set(tool.name, { ...tool,
					sourceInfo: { path: "/fixture/code-mode.ts", source: "test", scope: "temporary", origin: "top-level" } });
			},
			getAllTools: () => [...metadata.values()].map((tool) => ({ ...tool })),
			getActiveTools: () => [...active], setActiveTools: (names: string[]) => { active = names; },
		} as unknown as ExtensionAPI;
		extension(pi);
		const ctx = { cwd, hasUI: false, ui: { notify() {} } } as unknown as ExtensionCommandContext;
		await handlers.get("session_start")!({}, ctx);
		assert(active.includes("exec"));
		const original = definitions.get("exec")!;
		const info = metadata.get("exec")!;
		metadata.set("exec", replacement === "schema" ? { ...info, parameters: structuredClone(info.parameters) }
			: replacement === "source" ? { ...info, sourceInfo: { ...info.sourceInfo, path: "/foreign.ts" } }
			: { ...info, promptGuidelines: ["Foreign semantics"] });
		await commands.get("code-mode")!.handler("protocol auto", ctx);
		assert.equal(definitions.get("exec"), original);
		await assert.rejects(original.execute("call", { code: "1" }, undefined, undefined, ctx), /ownership lost/);
		await commands.get("code-mode")!.handler("off", ctx);
		assert(active.includes("exec"), "foreign tool must not be deactivated");
		assert(!active.includes("wait"), "still-owned wait is deactivated");
	}
});

test("authorization: off invalidates a still-pending confirmation", async () => {
	let finish!: (answer: boolean) => void;
	let shown!: () => void;
	const promptShown = new Promise<void>((resolve) => { shown = resolve; });
	const commands = new Map<string, { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }>();
	const tools: { name: string; description: string }[] = [];
	let active: string[] = ["read"];
	const api = {
		registerFlag() {}, getFlag: (name: string) => name === "code-mode-host" ? "/fixture-host" : undefined, on() {}, events: createEventBus(),
		registerCommand: (name: string, command: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }) => commands.set(name, command),
		registerTool: (tool: { name: string; description: string }) => tools.push(tool),
		getAllTools: () => tools, getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; },
	} as unknown as ExtensionAPI;
	extension(api);
	const ctx = {
		cwd: await scratch("prompt"), hasUI: true,
		ui: { confirm: () => { shown(); return new Promise<boolean>((resolve) => { finish = resolve; }); }, setStatus() {}, notify() {} },
	} as unknown as ExtensionCommandContext;
	const command = commands.get("code-mode")!;
	const pending = command.handler("on", ctx);
	await promptShown;
	await command.handler("off", ctx);
	finish(true);
	await assert.rejects(pending, /superseded/);
	assert.deepEqual(active, ["read"]);
});

test("extension shutdown closes factory admission and attempts independent cleanup despite release failures", async () => {
	const cwd = await scratch("shutdown");
	let active = ["read", "lookup", "second"], fail = false;
	const tools = new Map<string, ToolInfo>();
	const handlers = new Map<string, Set<(...args: any[]) => any>>();
	let second!: ReturnType<typeof createCodeModeDirectBinding>;
	const pi = {
		events: createEventBus(), registerFlag() {}, registerCommand() {},
		getFlag: (name: string) => ({
			"code-mode-host": "/fixture", "code-mode-read-root": cwd,
			"code-mode-tools": "fixture__lookup", "code-mode-visibility": "hide-bridged",
		})[name],
		on(name: string, handler: (...args: any[]) => any) {
			if (!handlers.has(name)) handlers.set(name, new Set());
			handlers.get(name)!.add(handler);
			return () => { handlers.get(name)!.delete(handler); };
		},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, { ...tool,
				sourceInfo: { path: "/fixture/owner.ts", source: "fixture", scope: "temporary", origin: "top-level" } });
		},
		getAllTools: () => [...tools.values()].map((tool) => ({ ...tool })),
		getActiveTools: () => [...active],
		setActiveTools(names: string[]) {
			if (fail && names.includes("lookup")) {
				assert.equal(second.binding.acquire(), undefined, "all controls close before the first restoration");
				throw new Error("restore failed");
			}
			active = [...names];
		},
	} as unknown as ExtensionAPI;
	extension(pi);
	for (const name of ["lookup", "second"]) pi.registerTool({ name, label: name, description: name, parameters: Type.Object({}),
		async execute() { return { content: [], details: {} }; } });
	let factory!: { create(pi: ExtensionAPI, options: { name: string; sourcePath: string }): ReturnType<typeof createCodeModeDirectBinding> };
	pi.events.emit("@oai404iao/pi-code-mode:direct-owner/v1", { version: 1, accept(value: typeof factory) { factory = value; } });
	const first = factory.create(pi, { name: "lookup", sourcePath: "/fixture/owner.ts" });
	second = factory.create(pi, { name: "second", sourcePath: "/fixture/owner.ts" });
	const registration = registerCodeModeTools(pi, { id: "fixture", tools: [{
		name: "lookup", description: "fixture", effect: "read", parameters: Type.Object({}), direct: first.binding,
		async invoke() { return { value: null }; },
	}] });
	const emit = async (name: string) => {
		for (const handler of [...(handlers.get(name) ?? [])]) await handler({}, { cwd, hasUI: false });
	};
	try {
		await emit("session_start");
		assert(!active.includes("lookup"));
		fail = true;
		await assert.rejects(emit("session_shutdown"), (error: AggregateError) => {
			assert.equal(error.errors.length, 2);
			return true;
		});
		assert.equal(second.activeIntent, undefined);
		assert.throws(() => factory.create(pi, { name: "second", sourcePath: "/fixture/owner.ts" }), /closing/);
		fail = false;
		await emit("session_shutdown");
		assert(active.includes("lookup"));
		assert.equal(first.activeIntent, undefined);
	} finally { fail = false; registration.dispose(); await emit("session_shutdown"); }
});
