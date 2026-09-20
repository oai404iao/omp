import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { piSession } from "./helpers.ts";
import { scratch } from "./helpers.ts";
import extension from "../src/extension.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createEventBus } from "@earendil-works/pi-coding-agent";

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
