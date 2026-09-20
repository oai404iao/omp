import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { piSession, scratch } from "./helpers.ts";
import { Type } from "typebox";
import { createCodeModeDirectBinding, registerCodeModeTools } from "../src/contributions.ts";

const host = process.env.CODE_MODE_TEST_HOST;
assert(host, "CODE_MODE_TEST_HOST required; no silent provider/Host skips");
process.env.XDG_STATE_HOME = await scratch("provider-state");

const code = "text((await tools.read({path:'fixture.txt'})).text); text(await tools.fixture__lookup({}))";
function openAI(action: "exec" | "wait" | "load_lookup" | undefined, cellId?: string): string {
	const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({
		id: "s1-completion", object: "chat.completion.chunk", created: 1, model: "s1",
		choices: [{ index: 0, delta, finish_reason }],
	})}\n\n`;
	return action
		? chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call-${action}`, type: "function", function: {
			name: action, arguments: JSON.stringify(action === "exec" ? { code, yield_time_ms: 0 } : action === "wait" ? { cell_id: cellId, yield_time_ms: 10000 } : {}),
		} }] }, null)
			+ chunk({}, "tool_calls") + "data: [DONE]\n\n"
		: chunk({ role: "assistant", content: "Done" }, null) + chunk({}, "stop") + "data: [DONE]\n\n";
}
function anthropic(action: "exec" | "wait" | "load_lookup" | undefined, cellId?: string): string {
	const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
	return event("message_start", { message: {
		id: "s1-message", type: "message", role: "assistant", model: "s1", content: [],
		stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 },
	} })
		+ event("content_block_start", { index: 0, content_block: action
			? { type: "tool_use", id: `call-${action}`, name: action, input: {} }
			: { type: "text", text: "" } })
		+ event("content_block_delta", { index: 0, delta: action
			? { type: "input_json_delta", partial_json: JSON.stringify(action === "exec" ? { code, yield_time_ms: 0 } : action === "wait" ? { cell_id: cellId, yield_time_ms: 10000 } : {}) }
			: { type: "text_delta", text: "Done" } })
		+ event("content_block_stop", { index: 0 })
		+ event("message_delta", { delta: { stop_reason: action ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } })
		+ event("message_stop", {});
}

for (const api of ["openai-completions", "anthropic-messages"]) {
	test(`real ${api}: a native loader adds a cooperative binding before the next tools snapshot`, { timeout: 20000 }, async (t) => {
		const requests: Record<string, unknown>[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input, init) => {
			const request = new Request(input, init);
			assert.equal(new URL(request.url).origin, "https://s1-fixture.invalid");
			const body = await request.json() as Record<string, unknown>;
			requests.push(body);
			assert(requests.length <= 4);
			const action = requests.length === 1 ? "load_lookup" : requests.length === 2 ? "exec" : requests.length === 3 ? "wait" : undefined;
			const id = JSON.stringify(body.messages).match(/cm-[a-f0-9-]{36}/)?.[0];
			if (action === "wait") assert(id);
			return new Response(api === "openai-completions" ? openAI(action, id) : anthropic(action, id),
				{ headers: { "content-type": "text/event-stream" } });
		};
		t.after(() => { globalThis.fetch = originalFetch; });
		const f = await piSession(t, { host, grant: true, api, visibility: "hide-bridged", tools: "fixture__lookup",
			activeTools: ["read", "lookup", "load_lookup", "exec", "wait"], factory: (pi) => {
				pi.registerTool({ name: "load_lookup", label: "Load lookup", description: "Load fixture tools", parameters: Type.Object({}),
					async execute() {
						pi.registerTool({ name: "lookup", label: "Lookup", description: "Dynamically loaded direct lookup", parameters: Type.Object({}),
							async execute() { throw new Error("Use the nested adapter"); } });
						const owner = createCodeModeDirectBinding(pi, { name: "lookup", sourcePath: "<inline:1>" });
						const registration = registerCodeModeTools(pi, { id: "fixture", tools: [{
							name: "lookup", description: "Dynamically contributed lookup", parameters: Type.Object({}), effect: "read",
							direct: owner.binding, async invoke() { return { value: "dynamic-nested-result" }; },
						}] });
						owner.reconcile();
						pi.on("session_shutdown", () => { registration.dispose(); owner.dispose(); });
						return { content: [{ type: "text", text: "Nested lookup ready" }], details: {} };
					},
				});
			} });
		await writeFile(join(f.cwd, "fixture.txt"), "dynamic-fixture-read");
		await f.session.prompt("Load the fixture, then use Code Mode.");
		assert.equal(requests.length, 4);
		assert.doesNotMatch(JSON.stringify(requests[0].tools), /fixture__lookup/);
		for (const request of requests.slice(1)) {
			assert.match(JSON.stringify(request.tools), /fixture__lookup/);
			assert(!(request.tools as Record<string, unknown>[]).some((tool) => api === "openai-completions"
				? (tool.function as Record<string, unknown>)?.name === "lookup" : tool.name === "lookup"));
		}
		assert.match(JSON.stringify(requests[3].messages), /dynamic-nested-result/);
		const loaderResult = f.session.messages.find((message) => message.role === "toolResult" && message.toolName === "load_lookup");
		assert(loaderResult?.role === "toolResult" && !loaderResult.isError);
		assert(!loaderResult.addedToolNames?.includes("lookup"), "do not forge deferred activation for a suppressed tool");
		await f.session.prompt("/code-mode off");
		assert(f.session.getActiveToolNames().includes("lookup"));
	});
}

for (const api of ["openai-completions", "anthropic-messages"]) for (const visibility of ["mixed", "hide-bridged"]) {
	test(`real ${api} adapter + real Pi + supervised Host, ${visibility} (fixture HTTP, no account)`, { timeout: 20000 }, async (t) => {
		const requests: Record<string, unknown>[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input, init) => {
			const request = new Request(input, init);
			assert.equal(new URL(request.url).origin, "https://s1-fixture.invalid", "No network access outside fixture transport");
			const body = await request.json() as Record<string, unknown>;
			requests.push(body);
			assert(requests.length <= 3, "Unexpected retry or extra model turn");
			const action = requests.length === 1 ? "exec" : requests.length === 2 ? "wait" : undefined;
			const cellId = JSON.stringify(body.messages).match(/cm-[a-f0-9-]{36}/)?.[0];
			if (action === "wait") assert(cellId);
			return new Response(api === "openai-completions" ? openAI(action, cellId) : anthropic(action, cellId),
				{ headers: { "content-type": "text/event-stream" } });
		};
		t.after(() => { globalThis.fetch = originalFetch; });
		const events: string[] = [];
		const f = await piSession(t, { host, grant: true, api, visibility, tools: "fixture__lookup", factory: (pi) => {
			pi.registerTool({ name: "lookup", label: "Lookup", description: "Direct fixture lookup", parameters: Type.Object({}),
				async execute() { throw new Error("The fixture must use its explicitly contributed adapter"); } });
			const owner = createCodeModeDirectBinding(pi, { name: "lookup", sourcePath: "<inline:1>" });
			const registration = registerCodeModeTools(pi, { id: "fixture", tools: [{
				name: "lookup", description: "Nested fixture lookup", parameters: Type.Object({}), effect: "read",
				direct: owner.binding, async invoke() { return { value: "contributed-with-owner-cooperation" }; },
			}] });
			pi.on("session_start", () => { owner.setActive(true); });
			pi.on("session_shutdown", () => { registration.dispose(); owner.dispose(); });
			pi.on("tool_call", (event) => { events.push(event.toolName); });
		} });
		await writeFile(join(f.cwd, "fixture.txt"), "real-file-through-code-mode");
		await f.session.prompt("Read fixture.txt through exec.");
		assert.equal(requests.length, 3);
		const tools = requests[0].tools as Record<string, unknown>[];
		const exec = tools.find((tool) => api === "openai-completions"
			? (tool.function as Record<string, unknown>)?.name === "exec" : tool.name === "exec");
		assert(exec);
		const schema = api === "openai-completions" ? (exec.function as Record<string, unknown>).parameters : exec.input_schema;
		assert.deepEqual((schema as { required: string[] }).required, ["code"]);
		assert(tools.some((tool) => api === "openai-completions"
			? (tool.function as Record<string, unknown>)?.name === "bash" : tool.name === "bash"), "mixed mode preserves direct tools");
		for (const request of requests) {
			assert.equal((request.tools as Record<string, unknown>[]).some((tool) => api === "openai-completions"
				? (tool.function as Record<string, unknown>)?.name === "lookup" : tool.name === "lookup"), visibility === "mixed");
			assert.match(JSON.stringify(request.tools), /fixture__lookup/, "nested documentation is sent in both modes");
		}
		assert.match(JSON.stringify(requests[2].messages), /real-file-through-code-mode/);
		assert.match(JSON.stringify(requests[2].messages), /contributed-with-owner-cooperation/);
		assert.deepEqual(events, ["exec", "wait"], "nested reads do not pretend to trigger Pi hooks");
		const result = f.session.messages.find((item) => item.role === "toolResult");
		assert(result?.role === "toolResult" && !result.isError);
		assert.equal(f.session.model?.api, api, "no provider replacement");
		await f.session.prompt("/code-mode off");
		assert(f.session.getActiveToolNames().includes("lookup"), "real provider run restores its direct owner");
	});
}
