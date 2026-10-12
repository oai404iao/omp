import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager, type ExtensionContext, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Value } from "typebox/value";
import { renderAgentCall, renderAgentMessage, renderAgentResult } from "../src/render.ts";
import { truncateUtf8 } from "../src/result.ts";
import { createAgentTools } from "../src/tools.ts";
import { fixture } from "./support/fixture.ts";

const theme = { fg: (_color: unknown, text: string) => text, bold: (text: string) => text } as Theme;
type ToolRenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];
const executionContext = (context: ExtensionContext) => context as Parameters<ToolDefinition["execute"]>[4];

function renderContext(args: Record<string, unknown>, overrides: Partial<ToolRenderContext> = {}): ToolRenderContext {
	return {
		args, toolCallId: "render-test", invalidate() {}, lastComponent: undefined, state: {}, cwd: "/",
		executionStarted: true, argsComplete: true, isPartial: false, expanded: false, showImages: false,
		isError: false, ...overrides,
	};
}

function toolNamed(tools: ToolDefinition[], name: string): ToolDefinition {
	const tool = tools.find(tool => tool.name === name);
	assert(tool, name);
	return tool;
}

function callText(tool: ToolDefinition, args: Record<string, unknown>): string {
	return tool.renderCall!(args, theme, renderContext(args)).render(160).join("\n");
}

type ToolResult = Awaited<ReturnType<ToolDefinition["execute"]>>;
function resultText(tool: ToolDefinition, result: ToolResult, args: Record<string, unknown> = {}): string {
	return tool.renderResult!(result, { expanded: false, isPartial: false }, theme, renderContext(args))
		.render(160).join("\n");
}

test("all six tools render Type while keeping model-facing results and output schemas unchanged", async t => {
	const f = await fixture(t);
	const tools = createAgentTools(f.coordinator, () => f.caller, f.coordinator.catalog(f.caller).agents);
	const results: Array<{ name: string; value: ToolResult; type?: string }> = [];
	async function execute(name: string, args: Record<string, unknown>, expected: Record<string, unknown>, type?: string) {
		const tool = toolNamed(tools, name);
		const value = await tool.execute(name, args, undefined, undefined, executionContext(f.context));
		assert.deepEqual(value.content, [{ type: "text", text: JSON.stringify(expected) }]);
		assert.deepEqual(value.structuredContent, expected);
		const { render, ...details } = value.details as Record<string, unknown>;
		assert.deepEqual(details, expected);
		assert(render);
		assert(tool.outputSchema);
		assert(Value.Check(tool.outputSchema, expected));
		assert(!Value.Check(tool.outputSchema, { ...expected, render: {} }));
		assert.doesNotMatch(JSON.stringify(tool.outputSchema), /agent_type|agentType|render/);
		if (type) {
			assert.deepEqual(render, { agentType: type });
			const label = name === "wait_agent" ? "Caller Type" : "Type";
			assert.match(callText(tool, args), new RegExp(`${label}: ${type}`));
			assert.match(resultText(tool, value, args), new RegExp(`${label}: ${type}`));
		}
		results.push({ name, value, type });
		return value;
	}
	await execute("spawn_agent", { task_name: "named", agent_type: "scout", message: "Inspect", fork_turns: "none" },
		{ task_name: "/root/named" }, "scout");
	await f.idle();
	await execute("spawn_agent", { task_name: "plain", message: "Inspect", fork_turns: "none" },
		{ task_name: "/root/plain" }, "default");
	await f.idle();
	await execute("send_message", { target: "named", message: "More context" }, { accepted: true }, "scout");
	await execute("followup_task", { target: "/root/named", message: "Continue" }, { accepted: true }, "scout");
	await f.idle();
	await execute("interrupt_agent", { target: "plain" }, { previous_status: "completed" }, "default");
	const waitExpected = { ...await f.coordinator.wait(f.caller) };
	await execute("wait_agent", { timeout_ms: 300_000 }, waitExpected, "root");
	assert.match(callText(toolNamed(tools, "wait_agent"), { timeout_ms: 300_000 }), /Timeout: 300000 ms/);
	const listExpected = f.coordinator.list(f.caller);
	const listed = await execute("list_agents", {}, listExpected);
	assert.deepEqual((listed.details as Record<string, unknown>).render, {
		agentTypes: { "/root": "root", "/root/named": "scout", "/root/plain": "default" },
	});
	const listText = resultText(toolNamed(tools, "list_agents"), listed);
	for (const [path, type] of [["/root", "root"], ["/root/named", "scout"], ["/root/plain", "default"]]) {
		assert.match(listText, new RegExp(`${path} \\[[^\\]]+\\].*Type: ${type}`));
	}
	assert.doesNotMatch(callText(toolNamed(tools, "list_agents"), {}), /Type:/);
	assert.deepEqual(Object.keys((toolNamed(tools, "list_agents").outputSchema as any).properties.agents.items.properties),
		["agent_name", "agent_status"]);
	assert.equal(resultText(toolNamed(tools, "list_agents"), {
		content: listed.content, details: listExpected,
	}), listText, "Legacy details should resolve Types from the live identity store");

	// Replay serialized results after detaching the session: metadata must not depend on live state or current args.
	const detached = createAgentTools(() => { throw new Error("controller unavailable"); },
		() => { throw new Error("render must not attach a caller"); }, []);
	for (const { name, value, type } of results) {
		const tool = toolNamed(detached, name);
		const context = renderContext({ target: "/root/missing", ...(name === "spawn_agent" && type === "scout" ? { agent_type: type } : {}) });
		// Pi constructs both components before rendering either one.
		const call = tool.renderCall!(context.args, theme, context);
		const output = tool.renderResult!(JSON.parse(JSON.stringify(value)),
			{ expanded: false, isPartial: false }, theme, context);
		const replayed = output.render(160).join("\n");
		if (type) assert.match(replayed, new RegExp(`${name === "wait_agent" ? "Caller Type" : "Type"}: ${type}`));
		else assert.equal(replayed, listText);
		if (type) assert.match(call.render(160).join("\n"),
			new RegExp(`${name === "wait_agent" ? "Caller Type" : "Type"}: ${type}`));
	}
});

test("target Types resolve canonical and caller-relative identities without starting runtimes", async t => {
	const f = await fixture(t);
	await f.coordinator.spawn(f.caller, { task_name: "parent", agent_type: "scout", message: "Inspect" });
	await f.idle();
	const parent = {
		...f.caller, path: "/root/parent", depth: 1,
		sessionManager: SessionManager.open(f.coordinator.treeStore.record("/root/parent").sessionFile),
	};
	await f.coordinator.spawn(parent, { task_name: "nested", agent_type: "empty", message: "Inspect", fork_turns: "none" });
	await f.idle();
	const rootTools = createAgentTools(f.coordinator, () => { throw new Error("render attached root"); }, []);
	const childTools = createAgentTools(f.coordinator, () => { throw new Error("render attached child"); }, [], parent.path);
	const requests = f.requests.length;
	const snapshot = structuredClone(f.coordinator.treeStore.snapshot);
	for (const name of ["send_message", "followup_task", "interrupt_agent"]) {
		for (const target of ["parent/nested", "/root/parent/nested"]) {
			assert.match(callText(toolNamed(rootTools, name), { target }), /Type: empty/);
		}
		for (const target of ["nested", "/root/parent/nested"]) {
			assert.match(callText(toolNamed(childTools, name), { target }), /Type: empty/);
		}
		assert.match(callText(toolNamed(childTools, name), { target: "/root" }), /Type: root/);
		for (const target of ["missing", "../nested", "/other", 123]) {
			assert.match(callText(toolNamed(childTools, name), { target }), /Type: unknown/);
		}
	}
	assert.match(callText(toolNamed(childTools, "wait_agent"), { timeout_ms: 42_000 }), /Caller Type: scout/);
	assert.match(callText(toolNamed(rootTools, "wait_agent"), {}), /Caller Type: root/);
	assert.equal(f.requests.length, requests);
	assert.equal(f.coordinator.activeCount, 0);
	assert.deepEqual(f.coordinator.treeStore.snapshot, snapshot);

	const childExecuteTools = createAgentTools(f.coordinator, () => parent, [], parent.path);
	const send = toolNamed(childExecuteTools, "send_message");
	const sent = await send.execute("send", { target: "nested", message: "Context" }, undefined, undefined, executionContext(f.context));
	assert.match(resultText(send, sent), /Type: empty/);
	f.coordinator.send(f.caller, parent.path, "Wake child");
	const wait = toolNamed(childExecuteTools, "wait_agent");
	const waited = await wait.execute("wait", {}, undefined, undefined, executionContext(f.context));
	assert.match(resultText(wait, waited), /Caller Type: scout/);
});

test("timed-out wait renders caller identity without changing timeout output", async t => {
	const f = await fixture(t);
	const wait = toolNamed(createAgentTools(f.coordinator, () => f.caller, []), "wait_agent");
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const pending = wait.execute("wait", { timeout_ms: 10_000 }, undefined, undefined, executionContext(f.context));
	t.mock.timers.tick(10_000);
	const result = await pending;
	assert.deepEqual(result.structuredContent, {
		message: "No new mailbox activity before the wait deadline. This timeout does not cancel agents or indicate task failure.",
		timed_out: true,
	});
	assert.match(resultText(wait, result), /Caller Type: root/);
	assert.match(resultText(wait, result), /"timed_out":true/);
});

test("legacy, unknown, error and partial tool rows render safely without live controller state", () => {
	const tools = createAgentTools(() => { throw new Error("detached"); },
		() => { throw new Error("must not attach"); }, []);
	assert.match(callText(toolNamed(tools, "spawn_agent"), { task_name: "job" }), /Type: default/);
	assert.match(callText(toolNamed(tools, "spawn_agent"), { task_name: "job", agent_type: "scout" }), /Type: scout/);
	for (const name of ["send_message", "followup_task", "interrupt_agent"]) {
		const tool = toolNamed(tools, name);
		assert.match(callText(tool, { target: "missing" }), /Type: unknown/);
		for (const text of ['{"accepted":true}', "Error: target missing", '{"partial"', "null", ""]) {
			const context = renderContext({ target: "missing" }, { isError: true, isPartial: true });
			const rendered = tool.renderResult!({ content: [{ type: "text", text }], details: undefined },
				{ expanded: false, isPartial: true }, theme, context).render(160).join("\n");
			assert.match(rendered, /Type: unknown/);
			if (text) assert(rendered.includes(text));
		}
	}
	const legacyList = { content: [{ type: "text" as const, text: '{"agents":[{"agent_name":"/root/old","agent_status":"completed"}]}' }], details: undefined };
	assert.match(resultText(toolNamed(tools, "list_agents"), legacyList), /\/root\/old \[completed\].*Type: unknown/);
	assert.match(resultText(toolNamed(tools, "spawn_agent"),
		{ content: [{ type: "text", text: '{"task_name":"/root/old"}' }], details: undefined },
		{ agent_type: "scout" }), /Type: scout\s*\nStarted \/root\/old/);
});

test("tool/message rendering handles narrow widths, Unicode, partial results and collapsed bodies", () => {
	const call = renderAgentCall("spawn_agent", { task_name: "review", message: "审查结果 ".repeat(100) }, theme);
	for (const line of call.render(24)) assert(visibleWidth(line) <= 24);
	assert.match(renderAgentResult([{ type: "text", text: '{"task_name":"/root/review"}' }], false, theme).render(80).join("\n"), /Started \/root\/review/);
	assert.doesNotThrow(() => renderAgentResult([{ type: "text", text: '{"partial"' }], false, theme).render(20));
	const body = Array.from({ length: 20 }, (_, n) => `line ${n}`).join("\n");
	assert.doesNotMatch(renderAgentMessage(body, false, theme).render(80).join("\n"), /line 19/);
	assert.match(renderAgentMessage(body, true, theme).render(80).join("\n"), /line 19/);
	const clipped = truncateUtf8("中文🙂", 7);
	assert.equal(clipped.text, "中文");
	assert.equal(clipped.omittedBytes, 4);
});

test("Type metadata is Unicode-width safe and retained in collapsed and expanded results", () => {
	const agents = Array.from({ length: 12 }, (_, n) => ({ agent_name: `/root/task_${n}`, agent_status: "completed" }));
	const details = { agentTypes: Object.fromEntries(agents.map(agent => [agent.agent_name, "审查🙂"])) };
	const content = [{ type: "text", text: JSON.stringify({ agents }) }];
	for (const expanded of [false, true]) {
		const rendered = renderAgentResult(content, expanded, theme, details);
		const wide = rendered.render(160).join("\n");
		assert.match(wide, /Type: 审查🙂/);
		if (expanded) assert.match(wide, /task_11/);
		else {
			assert.doesNotMatch(wide, /task_11/);
			assert.match(wide, /…/);
		}
		for (const width of [8, 24]) {
			for (const line of rendered.render(width)) assert(visibleWidth(line) <= width);
		}
		const call = renderAgentCall("spawn_agent", { task_name: "审查🙂", agent_type: "审查🙂", message: "中文🙂 ".repeat(50) }, theme);
		for (const line of call.render(8)) assert(visibleWidth(line) <= 8);
	}
});
