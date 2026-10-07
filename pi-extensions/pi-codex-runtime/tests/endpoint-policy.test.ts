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

test("wire-off preserves standard hosted tools, blocks Lite and changes the cache discriminator", () => {
	const on = loadModelSettings(model, undefined, DEFAULT_SETTINGS);
	const off = loadModelSettings(model, undefined, { ...DEFAULT_SETTINGS, codexRequestExtensions: false });
	assert.equal(off.webSearchImplementation, on.webSearchImplementation);
	assert.equal(off.imageGenerationImplementation, on.imageGenerationImplementation);
	assert.equal(off.compactionMode, "pi");
	assert.notEqual(off.modelProfileHash, on.modelProfileHash);
	assert.equal(off.requestBlockedReason, undefined);
	const lite = loadModelSettings({ ...model, id: "gpt-5.6-sol" }, undefined, { ...DEFAULT_SETTINGS, codexRequestExtensions: false });
	assert.match(lite.requestBlockedReason!, /Lite requires/);
	assert.equal(lite.openaiWebSocketPrewarm, false);
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
