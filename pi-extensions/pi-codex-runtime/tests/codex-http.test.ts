import assert from "node:assert/strict";
import test from "node:test";
import {
	buildCodexJsonHeaders,
	hasCodexRequestAuth,
	resolveCodexRequestAccountId,
	resolveResponsesUrl,
	resolveCodexApiEndpoint,
	responsesProtocol,
	withResolvedAuthBaseUrl,
} from "@oai404iao/pi-codex-runtime/internal/codex-http";

test("provider auth headers can remove inherited values with null", () => {
	const headers = buildCodexJsonHeaders({
		modelHeaders: {
			Authorization: "Bearer inherited",
			"X-Inherited": "remove-me",
		},
		auth: {
			apiKey: "replacement",
			headers: {
				authorization: null,
				"x-inherited": null,
				"x-request": "kept",
			},
		},
		endpoint: "openai",
	});

	assert.equal(headers.get("authorization"), null);
	assert.equal(headers.get("x-inherited"), null);
	assert.equal(headers.get("x-request"), "kept");
});

test("null Authorization suppresses API-key bearer generation", () => {
	const options = {
		modelHeaders: { Authorization: "Bearer stale-model-token" },
		auth: {
			apiKey: "secret",
			headers: {
				authorization: null,
				"x-api-key": "proxy-key",
			},
		},
		endpoint: "openai" as const,
	};
	const headers = buildCodexJsonHeaders(options);

	assert.equal(headers.get("authorization"), null);
	assert.equal(headers.get("x-api-key"), "proxy-key");
	assert.equal(hasCodexRequestAuth(options), true);
});

test("null authorization removes model auth when no fallback key exists", () => {
	assert.equal(hasCodexRequestAuth({
		modelHeaders: { Authorization: "Bearer inherited" },
		auth: { headers: { authorization: null } },
	}), false);
});

test("removed model Authorization is not reused for account-id extraction", () => {
	assert.equal(resolveCodexRequestAccountId({
		modelHeaders: { Authorization: "Bearer stale-non-jwt-token" },
		auth: {
			headers: {
				authorization: null,
				"x-api-key": "valid-request-key",
			},
		},
		endpoint: "codex",
	}), undefined);
});

test("model-level null suppresses generated authorization and originator", () => {
	const headers = buildCodexJsonHeaders({
		modelHeaders: {
			Authorization: null,
			originator: null,
			"x-generated": null,
		},
		auth: { apiKey: "secret" },
		endpoint: "openai",
		extraHeaders: { "x-generated": "generated" },
	});

	assert.equal(headers.get("authorization"), null);
	assert.equal(headers.get("originator"), null);
	assert.equal(headers.get("x-generated"), null);
});

test("empty request Authorization does not fall back to an unrelated API key for account id", () => {
	assert.equal(resolveCodexRequestAccountId({
		modelHeaders: { Authorization: "Bearer stale-model-token" },
		auth: {
			apiKey: "plain-api-key",
			headers: {
				authorization: " ",
				"x-api-key": "valid-request-key",
			},
		},
		endpoint: "codex",
	}), undefined);
});

test("explicit resolved authorization takes precedence over the API key", () => {
	const headers = buildCodexJsonHeaders({
		auth: {
			apiKey: "fallback",
			headers: { Authorization: "Bearer resolved" },
		},
		endpoint: "openai",
	});

	assert.equal(headers.get("authorization"), "Bearer resolved");
});

test("request protocol follows Pi API, not plugin endpoint or credential shape", () => {
	assert.equal(responsesProtocol({ provider: "openai", api: "openai-responses" }, "codex"), "openai");
	assert.equal(responsesProtocol({ provider: "proxy", api: "openai-codex-responses" }, "openai"), "codex");
	assert.equal(responsesProtocol({ provider: "proxy", api: "openai-responses" }, "codex"), "openai");
	assert.equal(responsesProtocol({ provider: "openai-codex", api: "openai-codex-responses" }, "openai"), "openai");
	for (const apiKey of ["sk-fixture", "chatgpt-access-token"]) {
		assert.equal(resolveCodexRequestAccountId({ endpoint: "openai", auth: { apiKey } }), undefined);
		assert.equal(buildCodexJsonHeaders({ endpoint: "openai", auth: { apiKey } }).get("chatgpt-account-id"), null);
	}
	assert.equal(hasCodexRequestAuth({ auth: { headers: { "cf-aig-authorization": "Bearer gateway" } } }), true);
});

test("shared endpoint assembly honors Pi's resolved base URL without mutating its model", () => {
	const model = { baseUrl: "https://api.openai.com/v1" };
	const resolved = withResolvedAuthBaseUrl(model, { baseUrl: "https://proxy.invalid/root" });
	assert.equal(model.baseUrl, "https://api.openai.com/v1");
	assert.equal(resolveResponsesUrl(resolved.baseUrl, "openai"), "https://proxy.invalid/root/responses");
	for (const base of ["https://proxy.invalid/root", "https://proxy.invalid/root/responses/"]) {
		assert.equal(resolveCodexApiEndpoint(base, "openai", "images/generations"), "https://proxy.invalid/root/images/generations");
	}
	for (const base of ["https://proxy.invalid/root", "https://proxy.invalid/root/codex", "https://proxy.invalid/root/codex/responses"]) {
		assert.equal(resolveCodexApiEndpoint(base, "codex", "alpha/search"), "https://proxy.invalid/root/codex/alpha/search");
	}
	assert.equal(resolveResponsesUrl(undefined, "openai"), "https://api.openai.com/v1/responses");
	assert.equal(resolveResponsesUrl(undefined, "codex"), "https://chatgpt.com/backend-api/codex/responses");
});
