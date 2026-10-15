import assert from "node:assert/strict";
import test from "node:test";
import core from "@oai404iao/pi-codex-core";
import tools from "@oai404iao/pi-codex-tools";
import imagegen from "@oai404iao/pi-codex-imagegen";
import { compositionModel, createCompositionHost, withCompositionDirectory, writeCompositionConfig } from "./support/composition-host.js";

const completed = () => new Response(`data: ${JSON.stringify({
	type: "response.completed", response: { id: "fixture", status: "completed", output: [
		{ type: "web_search_call", id: "web-fixture", status: "completed", action: { type: "search", queries: ["fixture"] } },
	], usage: { input_tokens: 1, output_tokens: 1 } },
})}\n\n`);

function request(host: ReturnType<typeof createCompositionHost>, headers?: Record<string, string>, maxRetries = 0) {
	return host.providers.get("openai").streamSimple(host.ctx.model, {
		messages: [{ role: "user", content: "fixture", timestamp: 1 }],
		tools: host.active().map(name => host.tools.get(name)).filter(Boolean),
	}, { apiKey: "sk-fixture", sessionId: host.ctx.sessionManager.getSessionId(), maxRetries, headers }).result();
}

for (const responsesMode of ["standard", "lite"]) for (const codexRequestExtensions of [false, true]) for (const compactionMode of ["pi", "responses"]) {
test(`core+tools ${responsesMode}, wire=${codexRequestExtensions}, compaction=${compactionMode} keeps independent protocol signals without images`, t =>
	withCompositionDirectory(async cwd => {
		writeCompositionConfig(cwd, {
			codexRequestExtensions, compactionMode, webSocketEnabled: false, imageGeneration: false,
			requestProfile: { responsesMode, patchTransport: "custom" },
		});
		const host = createCompositionHost(cwd);
		core(host.api()); tools(host.api());
		let requests = 0;
		t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
			requests++;
			assert.equal(String(url), `${host.ctx.model.baseUrl}/responses`);
			const headers = new Headers(init?.headers);
			if (!codexRequestExtensions) {
				for (const name of ["originator", "thread-id", "x-codex-turn-metadata", "x-codex-window-id", "x-openai-subagent"]) {
					assert.equal(headers.get(name), null, name);
				}
			} else {
				assert.equal(headers.get("originator"), "pi");
			}
			assert.equal(headers.get("x-openai-internal-codex-responses-lite"), responsesMode === "lite" ? "true" : null);
			assert.equal(headers.get("x-codex-beta-features"), compactionMode === "responses" ? "remote_compaction_v2" : null);
			const body = JSON.parse(String(init?.body));
			if (!codexRequestExtensions) assert.equal(body.client_metadata, undefined);
			assert.equal(body.parallel_tool_calls, responsesMode !== "lite");
			let declarations = body.tools;
			if (responsesMode === "lite") {
				assert.equal(body.tools, undefined);
				assert.equal(body.reasoning.context, "all_turns");
				const namespaces = body.input.find((item: any) => item.type === "additional_tools").tools;
				assert(!namespaces.some((item: any) => item.name === "image_gen"));
				declarations = namespaces.find((item: any) => item.name === "functions").tools;
			}
			assert(!declarations.some((tool: any) => tool.name === "image_generation"));
			const patch = declarations.find((tool: any) => tool.name === "apply_patch");
			assert.equal(patch.type, "custom");
			assert.equal(patch.format.type, "grammar");
			return completed();
		});
		try {
			await host.emit("session_start");
			const result = await request(host);
			assert.equal(result.stopReason, "stop", result.errorMessage);
			assert.equal(host.tools.has("image_generation"), false);
			assert.equal(host.commands.has("image-gen"), false);
			assert.equal(requests, 1);
		} finally { await host.emit("session_shutdown"); host.dispose(); }
	}));
}

for (const denial of [{ responsesMode: ["standard"] }, { transport: [] }]) {
	test(`wire-off Lite rejects explicit endpoint denial ${JSON.stringify(denial)} without fallback`, t =>
		withCompositionDirectory(async cwd => {
			const host = createCompositionHost(cwd);
			writeCompositionConfig(cwd, {
				codexRequestExtensions: false, webSocketEnabled: false,
				endpoint_config: [{ provider: host.ctx.model.provider, baseUrl: host.ctx.model.baseUrl, ...denial }],
			});
			core(host.api()); tools(host.api());
			let requests = 0;
			t.mock.method(globalThis, "fetch", async () => {
				requests++;
				throw new Error("Denied endpoint must not be called");
			});
			try {
				await host.emit("session_start");
				const result = await request(host);
				assert.equal(result.stopReason, "error");
				assert.match(result.errorMessage, /disabled for this endpoint/);
				assert.equal(requests, 0);
			} finally { await host.emit("session_shutdown"); host.dispose(); }
		}));
}

test("wire-off keeps hosted search replay and standalone function tools without optional Codex metadata", t =>
	withCompositionDirectory(async cwd => {
		writeCompositionConfig(cwd, { codexRequestExtensions: false, webSocketEnabled: false });
		const host = createCompositionHost(cwd);
		host.ctx.model = compositionModel("gpt-5.5");
		core(host.api()); tools(host.api());
		t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			const body = JSON.parse(String(init?.body));
			assert.equal(headers.get("authorization"), "Bearer sk-fixture");
			for (const name of ["originator", "openai-beta", "thread-id", "x-codex-turn-metadata", "x-openai-internal-codex-responses-lite", "x-openai-subagent"]) {
				assert.equal(headers.get(name), null, name);
			}
			assert.equal(headers.get("x-codex-beta-features"), "remote_compaction_v2", "native compaction keeps its mandatory capability signal");
			assert.equal(headers.get("x-codex-window-id"), "user-specified", "do not delete explicit user headers");
			assert.equal(body.client_metadata, undefined);
			assert.equal(body.prompt_cache_key, host.ctx.sessionManager.getSessionId());
			assert(body.tools.some((tool: any) => tool.type === "web_search"));
			assert(body.tools.some((tool: any) => tool.type === "function" && tool.name === "image_generation"));
			assert(!body.tools.some((tool: any) => tool.type === "namespace"));
			return completed();
		});
		try {
			await host.emit("session_start");
			const result = await request(host, { "x-codex-window-id": "user-specified" });
			assert.equal(result.stopReason, "stop", result.errorMessage);
			assert.match(JSON.stringify(result.content), /web_search_call/);
			assert.equal(host.tools.get("web_search").exposure, "model-only");
			assert.equal(host.tools.get("image_generation").exposure, "direct");
		} finally { await host.emit("session_shutdown"); host.dispose(); }
	}));

test("standalone policy follows auth-resolved URLs and wire-off omits image identity headers", t =>
	withCompositionDirectory(async cwd => {
		const host = createCompositionHost(cwd);
		host.ctx.model = compositionModel("gpt-5.5");
		const baseUrl = "https://resolved.invalid/v2";
		const config = {
			webSocketEnabled: false, codexRequestExtensions: false,
			endpoint_config: [{ provider: "openai", baseUrl: host.ctx.model.baseUrl, imageGeneration: [] }],
		};
		writeCompositionConfig(cwd, config);
		host.ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "resolved", baseUrl });
		imagegen(host.api());
		let requests = 0;
		t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
			requests++;
			assert.equal(String(url), `${baseUrl}/images/generations`);
			assert.equal(new Headers(init?.headers).get("x-codex-image-turn-id"), null);
			assert.equal(new Headers(init?.headers).get("originator"), null);
			return Response.json({ data: [{ b64_json: Buffer.from("fixture").toString("base64") }] });
		});
		try {
			await host.emit("session_start");
			assert(host.active().includes("image_generation"), "catalog URL restrictions cannot suppress the authenticated endpoint");
			const execute = () => host.tools.get("image_generation").execute("image", { prompt: "fixture" }, undefined, undefined, host.ctx);
			const result = await execute();
			assert(result.structuredContent.image.data);
			writeCompositionConfig(cwd, { ...config, endpoint_config: [{ provider: "openai", baseUrl, imageGeneration: [] }] });
			await assert.rejects(execute(), /disabled for this endpoint/);
			assert.equal(requests, 1);
			await host.emit("model_select");
			assert(!host.active().includes("image_generation"));
		} finally { await host.emit("session_shutdown"); host.dispose(); }
	}));

test("explicit hosted rejection disables only that mode for the current endpoint/session", t =>
	withCompositionDirectory(async cwd => {
		writeCompositionConfig(cwd, { webSocketEnabled: false });
		const host = createCompositionHost(cwd);
		host.ctx.model = compositionModel("gpt-5.5");
		const notices: string[] = [];
		host.ctx.ui = { notify: (message: string) => notices.push(message), setStatus() {}, setWidget() {} };
		core(host.api()); tools(host.api());
		let requests = 0;
		t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			requests++;
			if (requests === 1) {
				assert(body.tools.some((tool: any) => tool.type === "web_search"));
				return Response.json({ error: { code: "unsupported_tool", message: "web_search is not supported" } }, { status: 501 });
			}
			assert(!body.tools.some((tool: any) => tool.type === "web_search"));
			return completed();
		});
		try {
			await host.emit("session_start");
			assert.equal((await request(host, undefined, 2)).stopReason, "error");
			assert.equal(requests, 1, "explicit unsupported is not a transport retry");
			assert(!host.active().includes("web_search"));
			assert(host.active().includes("image_generation"));
			assert(notices.some(message => message.includes("disabled for this session")));
			assert.equal((await request(host)).stopReason, "stop");
			await host.emit("session_start");
			assert(host.active().includes("web_search"), "a new session lifecycle clears transient rejection");
		} finally { await host.emit("session_shutdown"); host.dispose(); }
	}));

test("endpoint allowlists block declarations once auth resolves without selecting an alternate implementation", t =>
	withCompositionDirectory(async cwd => {
		const model = compositionModel("gpt-5.5");
		writeCompositionConfig(cwd, { webSocketEnabled: false, endpoint_config: [{
			provider: model.provider, baseUrl: model.baseUrl,
			webSearch: ["standalone"], imageGeneration: [], compaction: [],
		}] });
		const host = createCompositionHost(cwd);
		host.ctx.model = model;
		core(host.api()); tools(host.api());
		t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			assert(!body.tools.some((tool: any) => tool.type === "web_search" || tool.name === "image_generation"));
			return completed();
		});
		try {
			await host.emit("session_start");
			assert.equal((await request(host)).stopReason, "stop");
			assert(!host.active().includes("web_search"));
			assert(!host.active().includes("image_generation"));
			assert(host.active().includes("apply_patch"));
		} finally { await host.emit("session_shutdown"); host.dispose(); }
	}));

test("first authenticated Lite request omits denied reserved search and image namespaces", t =>
	withCompositionDirectory(async cwd => {
		const host = createCompositionHost(cwd);
		writeCompositionConfig(cwd, { webSocketEnabled: false, endpoint_config: [{
			provider: host.ctx.model.provider, baseUrl: host.ctx.model.baseUrl,
			webSearch: [], imageGeneration: [],
		}] });
		core(host.api()); tools(host.api());
		t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			const namespaces = body.input.find((item: any) => item.type === "additional_tools").tools;
			assert(!namespaces.some((item: any) => item.name === "web" || item.name === "image_gen"));
			return completed();
		});
		try {
			await host.emit("session_start");
			assert.equal((await request(host)).stopReason, "stop");
		} finally { await host.emit("session_shutdown"); host.dispose(); }
	}));
