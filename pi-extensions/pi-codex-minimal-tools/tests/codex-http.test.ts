import assert from "node:assert/strict";
import test from "node:test";
import {
	buildCodexJsonHeaders,
	hasCodexRequestAuth,
	resolveCodexRequestAccountId,
} from "../src/codex-http.js";

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
		apiKeyMode: true,
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
		apiKeyMode: true,
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
		apiKeyMode: false,
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
		apiKeyMode: true,
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
		apiKeyMode: false,
	}), undefined);
});

test("explicit resolved authorization takes precedence over the API key", () => {
	const headers = buildCodexJsonHeaders({
		auth: {
			apiKey: "fallback",
			headers: { Authorization: "Bearer resolved" },
		},
		apiKeyMode: true,
	});

	assert.equal(headers.get("authorization"), "Bearer resolved");
});
