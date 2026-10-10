import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition, ToolLoadout } from "@earendil-works/pi-coding-agent";
import { getCodexBroker } from "@oai404iao/pi-codex-runtime/internal/broker";
import { resetCodexWireState } from "@oai404iao/pi-codex-runtime/internal/codex-wire-identity";
import { createApplyPatchToolDefinition } from "../src/tools/apply-patch.js";
import { activeToolSnapshot, hasProjectedToolLoadout } from "../src/extension/tool-snapshot.js";
import { startupPrewarmSnapshot } from "../src/extension/prewarm-snapshot.js";
import { createStartupPrewarmLifecycle } from "../src/extension/startup-prewarm.js";
import { closeProviderWebSocketSessions } from "../src/providers/openai-codex/websocket-session.js";
import { registerNativeCompaction } from "../src/native-compaction.js";
import { eventContext, responsesModel, withCodexSettings } from "../../../tests/codex/support/provider-lifecycle-test-support.js";
import { startWebSocketServer, successEvents } from "./support/websocket-test-support.js";

function patchFixture() {
	const patch = createApplyPatchToolDefinition({ deferRendering: true });
	let active = ["read", "edit", "write", "apply_patch", "custom_edit"];
	const tools = active.map(name => ({
		name,
		description: name === "apply_patch" ? patch.description as string : `${name} tool`,
		parameters: name === "apply_patch" ? patch.parameters : { type: "object", properties: {} },
		sourceInfo: { source: "extension", path: "/fixture/core.ts" },
	}));
	const handlers: Record<string, Function[]> = {};
	const pi = {
		on: (name: string, handler: Function) => { (handlers[name] ??= []).push(handler); },
		getActiveTools: () => [...active],
		getAllTools: () => tools,
		getThinkingLevel: () => "off",
	} as unknown as ExtensionAPI;
	const broker = getCodexBroker(pi);
	broker.tools.set("apply_patch", { registered: true, exposure: "direct", register() {} });
	broker.ownedTools.set("apply_patch", { parameters: patch.parameters, description: patch.description as string });
	return { pi, tools, handlers, broker, setActive(names: string[]) { active = names; } };
}

test("apply_patch loadout hides only selected edit/write declarations without mutating tools", () => {
	const patch = createApplyPatchToolDefinition({ deferRendering: true });
	const prepare = patch.prepareLoadout as NonNullable<ToolDefinition["prepareLoadout"]>;
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

test("owned active patch snapshots match its declaration projection and preserve selection", () => {
	const fixture = patchFixture();
	const selected = fixture.pi.getActiveTools();
	assert.equal(hasProjectedToolLoadout(fixture.pi), false);
	assert.deepEqual(activeToolSnapshot(fixture.pi).map(tool => tool.name), ["read", "apply_patch", "custom_edit"]);
	assert.deepEqual(startupPrewarmSnapshot(fixture.pi, {}).tools?.map(tool => tool.name), ["read", "apply_patch", "custom_edit"]);
	assert.deepEqual(fixture.pi.getActiveTools(), selected);
	assert.deepEqual(fixture.pi.getAllTools().map(tool => tool.name), selected);
	fixture.setActive(["read", "write", "apply_patch"]);
	assert.deepEqual(activeToolSnapshot(fixture.pi).map(tool => tool.name), ["read", "apply_patch"]);
	fixture.setActive(["read", "write"]);
	assert.deepEqual(activeToolSnapshot(fixture.pi).map(tool => tool.name), ["read", "write"]);
	fixture.setActive(["read", "apply_patch"]);
	assert.deepEqual(activeToolSnapshot(fixture.pi).map(tool => tool.name), ["read", "apply_patch"]);
});

for (const replacement of ["unowned", "unregistered", "description", "parameters", "source"] as const) {
	test(`snapshots do not hide native mutations for ${replacement} patch`, () => {
		const fixture = patchFixture();
		const patch = fixture.tools.find(tool => tool.name === "apply_patch")!;
		if (replacement === "unowned") fixture.broker.ownedTools.delete("apply_patch");
		else if (replacement === "unregistered") fixture.broker.tools.get("apply_patch")!.registered = false;
		else if (replacement === "description") patch.description = "foreign patch";
		else if (replacement === "parameters") patch.parameters = { type: "object", properties: {} };
		else patch.sourceInfo.source = "sdk";
		assert.deepEqual(activeToolSnapshot(fixture.pi).map(tool => tool.name), fixture.pi.getActiveTools());
	});
}

test("snapshots retain foreign mutation names after an owned patch replacement", () => {
	const fixture = patchFixture();
	assert.deepEqual(activeToolSnapshot(fixture.pi).map(tool => tool.name), ["read", "apply_patch", "custom_edit"]);
	const patch = fixture.tools.find(tool => tool.name === "apply_patch")!;
	patch.sourceInfo.path = "/fixture/foreign.ts";
	assert.deepEqual(activeToolSnapshot(fixture.pi).map(tool => tool.name), fixture.pi.getActiveTools());
});

for (const name of ["codemode", "tool_search"]) {
	test(`${name} still requires native projection skip even with owned patch`, () => {
		const fixture = patchFixture();
		fixture.setActive([...fixture.pi.getActiveTools(), name]);
		assert.equal(hasProjectedToolLoadout(fixture.pi), true);
	});
}

test("owned patch keeps speculative prewarm enabled with matching declarations", async () => {
	await withCodexSettings({ openaiTransport: "websocket", openaiWebSocketPrewarm: true }, async () => {
		const fixture = patchFixture();
		const server = await startWebSocketServer([() => successEvents("resp_patch_prewarm")]);
		const lifecycle = createStartupPrewarmLifecycle(fixture.pi);
		const ctx = eventContext({ ...responsesModel, baseUrl: server.url });
		try {
			lifecycle.start(ctx);
			const pending = lifecycle.get("lifecycle-test", ctx.model!);
			assert(pending);
			await pending;
			assert.equal(server.requests.length, 1);
			assert.equal(server.requests[0].generate, false);
			assert.deepEqual(server.requests[0].tools.map((tool: { name: string }) => tool.name), ["read", "apply_patch", "custom_edit"]);
			assert.deepEqual(fixture.pi.getActiveTools(), ["read", "edit", "write", "apply_patch", "custom_edit"]);
		} finally {
			lifecycle.reset();
			closeProviderWebSocketSessions();
			resetCodexWireState();
			await server.close();
		}
	});
});

test("native compaction uses the owned patch projection without changing transcript tools", async () => {
	await withCodexSettings({ compactionMode: "responses", openaiTransport: "sse" }, async cwd => {
		const fixture = patchFixture();
		registerNativeCompaction(fixture.pi);
		const previousFetch = globalThis.fetch;
		const bodies: any[] = [];
		globalThis.fetch = async (_url, init) => {
			bodies.push(JSON.parse(String(init?.body)));
			const event = { type: "response.completed", response: {
				id: "compact", status: "completed", output: [{ type: "compaction", encrypted_content: "opaque" }],
			} };
			return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } });
		};
		const selected = fixture.pi.getActiveTools();
		const branchEntries = [{
			type: "message", id: "user", parentId: null, timestamp: new Date(1).toISOString(),
			message: { role: "user", content: "compact", timestamp: 1 },
		}];
		const before = structuredClone(branchEntries);
		try {
			const handler = fixture.handlers.session_before_compact[0];
			const result = await handler({
				branchEntries, preparation: { firstKeptEntryId: "user", tokensBefore: 100 },
				signal: new AbortController().signal,
			}, {
				...eventContext(), cwd,
				sessionManager: { getLeafId: () => "user", getSessionId: () => "patch-compaction" },
				ui: { notify: (message: string) => assert.fail(message) },
			});
			assert(result?.compaction);
			assert.equal(bodies.length, 1);
			assert.deepEqual(bodies[0].tools.map((tool: { name: string }) => tool.name), ["read", "apply_patch", "custom_edit"]);
			assert.deepEqual(fixture.pi.getActiveTools(), selected);
			assert.deepEqual(branchEntries, before);
		} finally {
			globalThis.fetch = previousFetch;
			resetCodexWireState();
		}
	});
});
