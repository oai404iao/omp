import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition, ToolLoadout } from "@earendil-works/pi-coding-agent";
import { getCodexBroker } from "@oai404iao/pi-codex-runtime/internal/broker";
import codexTools from "../src/index.js";
import { createApplyPatchToolDefinition } from "../src/tools/apply-patch.js";
import { createWebSearchToolDefinition, standaloneWebSearch } from "../src/tools/web-search.js";
import { eventContext, responsesModel, withCodexSettings } from "../../../tests/codex/support/provider-lifecycle-test-support.js";

function fixture() {
	const tools = new Map<string, any>();
	let active: string[] = [];
	const pi = {
		events: new EventEmitter(),
		on() {},
		registerTool(tool: { name: string }) { tools.set(tool.name, tool); },
		registerCommand() {},
		registerMessageRenderer() {},
		getActiveTools: () => active,
		setActiveTools(names: string[]) { active = names; },
		getAllTools: () => [...tools.values()].map(tool => ({ ...tool, sourceInfo: { source: "extension", path: "/fixture/tools.ts" } })),
	} as unknown as ExtensionAPI;
	return { pi, tools };
}

test("custom patch requires actual matching engine capability, not coreEnabled", () =>
	withCodexSettings({}, async cwd => {
		const f = fixture();
		codexTools(f.pi);
		const ctx = { ...eventContext(), cwd };
		const tool = f.tools.get("apply_patch");
		const args = { input: "*** Begin Patch\n*** Add File: custom.txt\n+ok\n*** End Patch\n" };
		const broker = getCodexBroker(f.pi);
		broker.coreEnabled = true;
		await assert.rejects(tool.execute("id", args, undefined, undefined, ctx), /compatible Responses engine/);
		broker.engine = { customTools: true, hostedWebSearch: true, supports: () => false };
		await assert.rejects(tool.execute("id", args, undefined, undefined, ctx), /compatible Responses engine/);
		broker.engine = { customTools: true, hostedWebSearch: true, supports: () => true };
		const result = await tool.execute("id", args, undefined, undefined, ctx);
		assert.equal(result.structuredContent.files[0].path, "custom.txt");
		assert.equal(broker.ownedTools.get("apply_patch")?.protocol?.inputProperty, "input");
		assert.equal(broker.ownedTools.get("apply_patch")?.protocol?.customTool.type, "custom");
	}));

test("explicit function patch executes independently without a Responses engine", () =>
	withCodexSettings({}, async cwd => {
		writeFileSync(join(cwd, "extensions/pi-codex-minimal-tools/models.json"), JSON.stringify({
			version: 1,
			models: [{ id: "fixture/plain", enabled: true, tools: { applyPatch: "function" } }],
		}));
		const f = fixture();
		codexTools(f.pi);
		const ctx = { ...eventContext({ ...responsesModel, provider: "fixture", id: "plain", api: "openai-completions" } as never), cwd };
		const result = await f.tools.get("apply_patch").execute("id", {
			input: "*** Begin Patch\n*** Add File: independent.txt\n+ok\n*** End Patch\n",
		}, undefined, undefined, ctx);
		assert.equal(result.structuredContent.files[0].path, "independent.txt");
		assert.equal(getCodexBroker(f.pi).engine, undefined);
	}));

test("global web gate blocks explicit standalone and tool execution before authentication", () =>
	withCodexSettings({ webSearch: false }, async cwd => {
		let authenticated = false;
		const ctx = {
			...eventContext({ ...responsesModel, id: "gpt-5.6-sol" }), cwd, thinkingLevel: undefined,
			modelRegistry: { async getApiKeyAndHeaders() { authenticated = true; throw new Error("must not authenticate"); } },
		};
		await assert.rejects(standaloneWebSearch({ search_query: [{ q: "fixture" }] }, ctx), /disabled by global settings/);
		await assert.rejects(createWebSearchToolDefinition().execute("id", {}, undefined, undefined, ctx), /disabled by global settings/);
		assert.equal(authenticated, false);
	}));

test("patch loadout preserves native active/callable declarations and source history", () => {
	const tool = createApplyPatchToolDefinition({ deferRendering: true });
	const prepare = tool.prepareLoadout as NonNullable<ToolDefinition["prepareLoadout"]>;
	for (const names of [
		["read", "edit", "write", "apply_patch", "custom_edit"],
		["write", "read", "apply_patch"],
		["read", "apply_patch", "custom_edit"],
	]) {
		const declared = Object.freeze(names.map(name => Object.freeze({ name })));
		const loadout = { declared, callable: declared, registered: declared } as unknown as ToolLoadout;
		assert.deepEqual(prepare(loadout), { hiddenDeclarations: names.filter(name => name === "edit" || name === "write") });
		assert.deepEqual(loadout.declared.map(tool => tool.name), names);
		assert.equal(loadout.callable, declared);
		assert.equal(loadout.registered, declared);
	}
	assert.equal(prepare({ declared: [{ name: "edit" }, { name: "write" }] } as unknown as ToolLoadout), undefined);
});
