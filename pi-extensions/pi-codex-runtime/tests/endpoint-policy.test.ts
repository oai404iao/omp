import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { endpointDeclares, parseEndpointConfig } from "../src/endpoint-config.js";
import { clearEndpointFailures, endpointWasRejected, reportEndpointFailure, watchEndpointFailures } from "../src/endpoint-state.js";
import { loadModelSettings } from "../src/model-catalog/runtime.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";

const model = { provider: "openai", api: "openai-responses", id: "gpt-5.5", baseUrl: "https://fixture.invalid/v1" };
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let agentDir: string;
beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "codex-endpoint-policy-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
});
afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

test("endpoint declarations are exact allowlists, not implementation selectors", () => {
	const endpoint_config = [{
		provider: model.provider, baseUrl: `${model.baseUrl}/`,
		webSearch: ["standalone" as const], imageGeneration: [], compaction: [],
	}];
	const resolved = loadModelSettings(model, undefined, { ...DEFAULT_SETTINGS, endpoint_config });
	assert.equal(resolved.webSearchImplementation, undefined);
	assert.equal(resolved.imageGenerationImplementation, undefined);
	assert.equal(resolved.compactionMode, "pi");
	assert.equal(resolved.modelProfile?.effective.tools.webSearch && resolved.modelProfile.effective.tools.webSearch.implementation, "hosted");
	assert.equal(endpointDeclares(endpoint_config, { ...model, baseUrl: `${model.baseUrl}/other` }, "webSearch.hosted"), true);
	assert.equal(endpointDeclares(endpoint_config, { ...model, provider: "proxy" }, "webSearch.hosted"), true);
	assert.equal(endpointDeclares([{ provider: model.provider, baseUrl: model.baseUrl }], model, "webSearch.hosted"), true);
	assert.equal(endpointDeclares([{ provider: model.provider, baseUrl: model.baseUrl, webSearch: [] }], model, "webSearch.hosted"), false);
});

test("malformed capability lists fail closed locally and invalid URLs are diagnosed without secrets", () => {
	const result = parseEndpointConfig([
		{ provider: "openai", baseUrl: model.baseUrl, webSearch: ["guess"] },
		{ provider: "openai", baseUrl: "https://user:secret@fixture.invalid" },
		{ provider: "openai", baseUrl: model.baseUrl, webSearch: ["hosted"] },
	]);
	assert.deepEqual(result.entries, [{ provider: "openai", baseUrl: model.baseUrl, webSearch: [] }]);
	assert.equal(result.diagnostics.length, 3);
	assert.doesNotMatch(result.diagnostics.join("\n"), /secret/);
	assert.match(parseEndpointConfig({}).diagnostics[0]!, /array/);
});

test("removed hosted image and unary compaction declarations fail closed", () => {
	const parsed = parseEndpointConfig([{ provider: "openai", baseUrl: model.baseUrl,
		imageGeneration: ["hosted"], compaction: ["responses-compact"],
	}]);
	assert.deepEqual(parsed.entries[0], { provider: "openai", baseUrl: model.baseUrl,
		imageGeneration: [], compaction: [],
	});
	assert.equal(parsed.diagnostics.length, 2);
});

test("wire-off preserves mode, transport, tools and native compaction while changing the cache discriminator", () => {
	const on = loadModelSettings(model, undefined, DEFAULT_SETTINGS);
	const off = loadModelSettings(model, undefined, { ...DEFAULT_SETTINGS, codexRequestExtensions: false });
	assert.equal(off.webSearchImplementation, on.webSearchImplementation);
	assert.equal(off.imageGenerationImplementation, on.imageGenerationImplementation);
	assert.equal(off.compactionMode, "responses");
	assert.equal(off.opaqueReplayAllowed, true);
	assert.notEqual(off.modelProfileHash, on.modelProfileHash);
	assert.equal(off.requestBlockedReason, undefined);
	const lite = loadModelSettings({ ...model, id: "gpt-5.6-sol" }, undefined, { ...DEFAULT_SETTINGS, codexRequestExtensions: false });
	assert.equal(lite.requestBlockedReason, undefined);
	assert.equal(lite.requestProfile.responsesMode, "lite");
	assert.equal(lite.openaiWebSocketPrewarm, true);
	assert.equal(lite.compactionMode, "responses");
	assert.equal(lite.opaqueReplayAllowed, true);
});

test("mode, transport and compaction endpoint declarations are independent", () => {
	const liteModel = { ...model, id: "gpt-5.6-sol" };
	const resolve = (entry: Record<string, unknown>) => loadModelSettings(liteModel, undefined, {
		...DEFAULT_SETTINGS, codexRequestExtensions: false,
		endpoint_config: parseEndpointConfig([{ provider: model.provider, baseUrl: model.baseUrl, ...entry }]).entries,
	});
	const noLite = resolve({ responsesMode: ["standard"] });
	assert.match(noLite.requestBlockedReason!, /lite is disabled/);
	assert.equal(noLite.requestProfile.responsesMode, "lite");
	assert.equal(noLite.compactionMode, "responses");
	assert.equal(noLite.opaqueReplayAllowed, false);
	assert.equal(noLite.webSearchImplementation, "standalone");

	const noWebsocket = resolve({ transport: ["sse"] });
	assert.equal(noWebsocket.openaiTransport, "sse");
	assert.equal(noWebsocket.openaiWebSocketPrewarm, false);
	assert.equal(noWebsocket.compactionMode, "responses");
	assert.equal(noWebsocket.opaqueReplayAllowed, true);
	assert.equal(noWebsocket.requestBlockedReason, undefined);
	const noTransport = resolve({ transport: [] });
	assert.match(noTransport.requestBlockedReason!, /transport is disabled/);
	const noCompaction = resolve({ compaction: [] });
	assert.equal(noCompaction.requestBlockedReason, undefined);
	assert.equal(noCompaction.compactionMode, "pi");
	assert.equal(noCompaction.opaqueReplayAllowed, false);
	assert.equal(noCompaction.requestProfile.responsesMode, "lite");
	assert.equal(noCompaction.openaiTransport, "auto");
	assert.equal(noCompaction.webSearchImplementation, "standalone");
});

test("invalid mode and transport allowlists fail closed without changing other capabilities", () => {
	const parsed = parseEndpointConfig([{ provider: model.provider, baseUrl: model.baseUrl,
		responsesMode: ["guess"], transport: true, webSearch: ["hosted"],
	}]);
	assert.deepEqual(parsed.entries[0], { provider: model.provider, baseUrl: model.baseUrl,
		responsesMode: [], transport: [], webSearch: ["hosted"],
	});
	assert.equal(parsed.diagnostics.length, 2);
});

test("replay capability is independent of the selected compaction generation policy", () => {
	const resolved = loadModelSettings({ ...model, id: "gpt-4.1" }, undefined, DEFAULT_SETTINGS);
	assert.equal(resolved.compactionMode, "pi");
	assert.equal(resolved.opaqueReplayAllowed, true);
});

test("mode rejection does not disable transport or compaction at the same endpoint", () => {
	const stop = watchEndpointFailures("mode-policy", () => {});
	try {
		reportEndpointFailure(model, "mode-policy", ["responsesMode.lite", "transport.websocket", "compaction.responses"],
			{ status: 400, code: "unsupported_feature", message: "responses_lite is not supported" });
		assert.equal(endpointWasRejected(model, "mode-policy", "responsesMode.lite"), true);
		assert.equal(endpointWasRejected(model, "mode-policy", "transport.websocket"), false);
		assert.equal(endpointWasRejected(model, "mode-policy", "compaction.responses"), false);
		const resolved = loadModelSettings({ ...model, id: "gpt-5.6-sol" }, undefined, DEFAULT_SETTINGS, "mode-policy");
		assert.match(resolved.requestBlockedReason!, /lite is disabled/);
	} finally {
		stop();
		clearEndpointFailures("mode-policy");
	}
});

test("only explicit capability rejection disables the exact endpoint in the current live session", () => {
	const notices: string[] = [];
	const stop = watchEndpointFailures("policy-test", message => { if (message) notices.push(message); });
	try {
		for (const failure of [
			{ status: 401, responseBody: JSON.stringify({ error: { code: "unsupported_tool", message: "web_search unsupported" } }) },
			{ status: 429, code: "unsupported_tool", message: "web_search unsupported" },
			{ status: 500, code: "unsupported_tool", message: "web_search unsupported" },
			{ status: 404, responseBody: "not found" },
			{ status: 400, code: "unsupported_parameter", param: "tools[0].search_content_types", message: "Unsupported parameter for web_search" },
			new Error("request aborted"),
		]) reportEndpointFailure(model, "policy-test", ["webSearch.hosted"], failure);
		assert.deepEqual(notices, []);
		const failure = { status: 400, responseBody: JSON.stringify({ error: { code: "unsupported_tool", message: "web_search is not supported" } }) };
		reportEndpointFailure(model, "policy-test", ["webSearch.hosted"], failure);
		reportEndpointFailure(model, "policy-test", ["webSearch.hosted"], failure);
		assert.equal(notices.length, 1);
		assert.equal(endpointWasRejected(model, "policy-test", "webSearch.hosted"), true);
		assert.equal(endpointWasRejected(model, "policy-test", "webSearch.standalone"), false);
		assert.equal(endpointWasRejected(model, "another-session", "webSearch.hosted"), false);
		assert.equal(endpointWasRejected({ ...model, baseUrl: "https://other.invalid" }, "policy-test", "webSearch.hosted"), false);
		assert.equal(loadModelSettings(model, undefined, DEFAULT_SETTINGS, "policy-test").webSearchImplementation, undefined);
		assert.equal(loadModelSettings(model, undefined, DEFAULT_SETTINGS, "another-session").webSearchImplementation, "hosted");
		clearEndpointFailures("policy-test");
		reportEndpointFailure(model, "policy-test", ["webSearch.hosted"], failure);
		assert.equal(endpointWasRejected(model, "policy-test", "webSearch.hosted"), false);
	} finally {
		stop();
		clearEndpointFailures("policy-test");
	}
});
