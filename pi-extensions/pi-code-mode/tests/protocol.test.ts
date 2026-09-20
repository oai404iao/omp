import assert from "node:assert/strict";
import { test } from "node:test";
import { createEventBus, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveGrammarConstrainedSampling } from "@earendil-works/pi-ai/api/constrained-sampling";
import { decodeExec, encodeExec, EXEC_SAMPLING, projectExecHistory, protocolMode, resolveProtocol, TRANSPORT_DISCOVER } from "../src/protocol.ts";
import { execParameters } from "../src/public-tools.ts";
import { piSession } from "./helpers.ts";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { grammarResponse } from "./grammar-fixtures.ts";

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return { role: "assistant", api: "openai-responses", provider: "fixture", model: "model",
		timestamp: 1, stopReason: "toolUse", content,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

test("protocol: JSON default and a provider-neutral single-string grammar contract", () => {
	assert.equal(protocolMode(undefined), "json");
	assert.equal(protocolMode("auto"), "auto");
	assert.throws(() => protocolMode("codex"), /json, auto or grammar/);
	const tool = { name: "exec", description: "fixture", parameters: execParameters, constrainedSampling: EXEC_SAMPLING };
	assert.equal(resolveGrammarConstrainedSampling(tool, true)?.inputProperty, "code");
	assert.equal(resolveGrammarConstrainedSampling(tool, false), undefined);
});

test("protocol: pragma controls are bounded, conflicts/unknown keys fail before execution", () => {
	assert.deepEqual(decodeExec({ code: '// @exec: {"yield_time_ms":0,"timeout_ms":12,"max_tokens":1}\r\ntext("x")' }),
		{ code: 'text("x")', yield_time_ms: 0, timeout_ms: 12, max_tokens: 1 });
	assert.deepEqual(decodeExec({ code: "text(1)", timeout_ms: 7 }), { code: "text(1)", timeout_ms: 7 });
	for (const code of [
		'// @exec: {"timeout_ms":0}\ntext(1)', '// @exec: {"max_tokens":8193}\ntext(1)',
		'// @exec: {"yield_time_ms":30001}\ntext(1)', '// @exec: {"evil":true}\ntext(1)',
		"// @exec: not json\ntext(1)", "// @exec: {}", "// @exec: null\ntext(1)", "// @exec: {}\n ",
	]) assert.throws(() => decodeExec({ code }));
	assert.throws(() => decodeExec({ code: '// @exec: {"max_tokens":1}\ntext(1)', max_tokens: 2 }), /Conflicting/);
	assert.throws(() => decodeExec({ code: "text(1)", input: "foreign" }), /Unknown/);
	assert.throws(() => decodeExec({ code: " ".repeat(24576) + "x" }), /24 KiB/);
	assert.throws(() => decodeExec({ input: "text(1)" }), /string argument code/);
});

test("protocol: projection preserves options and raw bytes without changing saved history", () => {
	const raw = ' // @exec: { "yield_time_ms" : 0 }\r\ntext("😀");\n';
	assert.equal(encodeExec({ code: raw }), raw);
	const canonical = encodeExec({ code: "text(1)", yield_time_ms: 0, timeout_ms: 37 });
	assert.deepEqual(decodeExec({ code: canonical }), { code: "text(1)", yield_time_ms: 0, timeout_ms: 37 });
	const messages = [assistant([
		{ type: "toolCall", id: "call", name: "exec", arguments: { code: "text(1)", yield_time_ms: 0 } },
		{ type: "toolCall", id: "foreign", name: "not_exec", arguments: { code: "x" } },
	])];
	const saved = structuredClone(messages);
	const projected = projectExecHistory(messages);
	assert.deepEqual(messages, saved);
	assert.match(JSON.stringify(projected), /@exec:/);
	const invalid = [assistant([{ type: "toolCall", id: "bad", name: "exec", arguments: { input: "x" } }])];
	assert.deepEqual(projectExecHistory(invalid), invalid);
});

test("protocol: capability metadata plus exact custom-stream handshake, not provider names", () => {
	const pi = { events: createEventBus() } as unknown as ExtensionAPI;
	let override: unknown;
	let nativeOverride: unknown;
	const ctx = {
		model: { provider: "not_openai", api: "openai-responses", compat: { supportsOpenAIGrammarTools: true } },
		modelRegistry: {
			getRegisteredProviderConfig: () => ({ streamSimple: override }),
			getRegisteredNativeProvider: () => nativeOverride ? { streamSimple: nativeOverride } : undefined,
		},
		sessionManager: { getBranch: () => [] },
	} as unknown as ExtensionContext;
	assert(resolveProtocol(pi, ctx, "auto").grammar);
	override = () => {};
	assert(!resolveProtocol(pi, ctx, "auto").grammar);
	const foreign = () => {};
	const off = pi.events.on(TRANSPORT_DISCOVER, (value) => (value as { accept(value: unknown): void }).accept(foreign));
	assert(!resolveProtocol(pi, ctx, "auto").grammar);
	off();
	pi.events.on(TRANSPORT_DISCOVER, (value) => (value as { accept(value: unknown): void }).accept(override));
	assert(resolveProtocol(pi, ctx, "auto").grammar);
	override = undefined; nativeOverride = () => {};
	assert(!resolveProtocol(pi, ctx, "auto").grammar, "native Provider objects also need an exact handshake");
	pi.events.on(TRANSPORT_DISCOVER, (value) => (value as { accept(value: unknown): void }).accept(nativeOverride));
	assert(resolveProtocol(pi, ctx, "auto").grammar);
	Object.assign(ctx.model!, { api: "anthropic-messages" });
	assert(!resolveProtocol(pi, ctx, "auto").grammar);
});

test("real Pi: protocol changes refresh definitions, JSON fallback and malformed history are explicit", async (t) => {
	const f = await piSession(t, { grant: true, host: "/not-started", protocol: "auto", grammar: true, api: "openai-responses" });
	assert.equal(f.session.getToolDefinition("exec")?.constrainedSampling && f.session.getToolDefinition("exec")?.constrainedSampling !== false, true);
	await f.session.prompt("/code-mode protocol json");
	assert.equal(f.session.getToolDefinition("exec")?.constrainedSampling, false);
	await f.session.prompt("/code-mode protocol auto");
	await f.session.setModel({ ...f.session.model!, id: "no-capability", compat: { supportsOpenAIGrammarTools: false } });
	assert.equal(f.session.getToolDefinition("exec")?.constrainedSampling, false);
	assert.match(f.session.getAllTools().find((tool) => tool.name === "exec")!.description, /does not declare/);
	await f.session.setModel({ ...f.session.model!, id: "capability", compat: { supportsOpenAIGrammarTools: true } });
	f.session.sessionManager.appendMessage({
		role: "assistant", api: "openai-responses", provider: "s1-fixture", model: "s1", timestamp: 1, stopReason: "toolUse",
		content: [{ type: "toolCall", id: "invalid", name: "exec", arguments: { code: 1 } }],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	});
	await f.session.prompt("/code-mode protocol auto");
	assert.equal(f.session.getToolDefinition("exec")?.constrainedSampling, false);
	assert.match(f.session.getAllTools().find((tool) => tool.name === "exec")!.description, /incompatible arguments/);
});

test("real Pi: native Provider-object overrides cannot bypass the transport handshake", async (t) => {
	let pi!: ExtensionAPI;
	const f = await piSession(t, { grant: true, host: "/not-started", protocol: "auto", grammar: true, api: "openai-responses",
		factory: (api) => { pi = api; } });
	const base = f.modelRuntime.getProvider("s1-fixture")!;
	const streamSimple = base.streamSimple.bind(base);
	f.modelRuntime.registerNativeProvider({
		id: base.id, name: base.name, baseUrl: base.baseUrl, auth: base.auth, getModels: () => base.getModels(),
		stream: base.stream.bind(base), streamSimple,
	});
	await f.session.prompt("/code-mode protocol auto");
	assert.equal(f.session.getToolDefinition("exec")?.constrainedSampling, false);
	assert.match(f.session.getAllTools().find((tool) => tool.name === "exec")!.description, /no matching grammar handshake/);
	pi.events.on(TRANSPORT_DISCOVER, (request) => (request as { accept(stream: unknown): void }).accept(streamSimple));
	await f.session.prompt("/code-mode protocol auto");
	assert(f.session.getToolDefinition("exec")?.constrainedSampling);
});

test("real Pi: forced grammar on an unsupported model fails before any Host initialization", async (t) => {
	const original = globalThis.fetch;
	let requests = 0;
	globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		assert.equal(new URL(request.url).origin, "https://s1-fixture.invalid");
		assert(++requests <= 2);
		return grammarResponse("openai-completions", requests === 1 ? { name: "exec", args: { code: "text('must not run')" } } : undefined);
	};
	t.after(() => { globalThis.fetch = original; });
	const f = await piSession(t, { grant: true, host: "/deliberately-not-an-executable", protocol: "grammar" });
	await f.session.prompt("Attempt execution.");
	const result = f.session.messages.find((message) => message.role === "toolResult");
	assert(result?.role === "toolResult" && result.isError);
	assert.match(JSON.stringify(result.content), /Code Mode grammar unavailable/);
	assert.equal(requests, 2);
});
