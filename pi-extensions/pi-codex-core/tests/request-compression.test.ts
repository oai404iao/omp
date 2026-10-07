import assert from "node:assert/strict";
import { zstdDecompressSync } from "node:zlib";
import test from "node:test";
import { prepareSseBody } from "@oai404iao/pi-codex-core/internal/providers/openai-codex/request-compression";
import { codexJwt } from "./support/openai-codex-test-support.js";

const endpoint = "https://chatgpt.com/backend-api/codex/responses";
const payload = JSON.stringify({ input: [{ role: "user", content: "synthetic fixture ".repeat(100) }] });

for (const [url, provider] of [[endpoint, "openai-codex"], ["https://api.openai.com/v1/responses", "openai"]]) test(`verified ${provider} OAuth compression round-trips`, () => {
	const headers = new Headers({ authorization: `Bearer ${codexJwt()}`, "content-length": String(Buffer.byteLength(payload)) });
	const body = prepareSseBody(url, payload, headers, provider);
	assert.notEqual(typeof body, "string");
	assert.equal(headers.get("content-encoding"), "zstd");
	assert.equal(headers.get("content-length"), null);
	assert.equal(zstdDecompressSync(body as Uint8Array).toString(), payload);
	assert.ok((body as Uint8Array).byteLength < Buffer.byteLength(payload));
});

test("compression does not guess support or override explicit content encoding", () => {
	for (const [url, provider, token] of [
		[endpoint, "openai-codex", "sk-fixture"],
		[endpoint, "custom", codexJwt()],
		["https://custom.invalid/backend-api/codex/responses", "openai-codex", codexJwt()],
		[`${endpoint}?query=custom`, "openai-codex", codexJwt()],
		[`${endpoint}/compact`, "openai-codex", codexJwt()],
	] as const) {
		const headers = new Headers({ authorization: `Bearer ${token}` });
		assert.equal(prepareSseBody(url, payload, headers, provider), payload);
		assert.equal(headers.has("content-encoding"), false);
	}
	const headers = new Headers({ authorization: `Bearer ${codexJwt()}`, "content-encoding": "identity" });
	assert.equal(prepareSseBody(endpoint, payload, headers, "openai-codex"), payload);
	assert.equal(headers.get("content-encoding"), "identity");
	assert.equal(prepareSseBody(endpoint, "{}", new Headers(), "openai-codex"), "{}");
});
