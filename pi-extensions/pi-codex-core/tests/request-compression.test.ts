import assert from "node:assert/strict";
import { zstdDecompressSync } from "node:zlib";
import test from "node:test";
import { prepareSseBody } from "@oai404iao/pi-codex-core/internal/providers/openai-codex/request-compression";

const endpoint = "https://chatgpt.com/backend-api/codex/responses";
const payload = JSON.stringify({ input: [{ role: "user", content: "synthetic fixture ".repeat(100) }] });

test("known Codex SSE compression round-trips and reduces bytes", () => {
	const headers = new Headers({ "content-length": String(Buffer.byteLength(payload)) });
	const body = prepareSseBody(endpoint, payload, headers, false);
	assert.notEqual(typeof body, "string");
	assert.equal(headers.get("content-encoding"), "zstd");
	assert.equal(headers.get("content-length"), null);
	assert.equal(zstdDecompressSync(body as Uint8Array).toString(), payload);
	assert.ok((body as Uint8Array).byteLength < Buffer.byteLength(payload));
});

test("compression does not guess support or override explicit content encoding", () => {
	for (const [url, apiKeyMode] of [
		[endpoint, true],
		["https://custom.invalid/backend-api/codex/responses", false],
		[`${endpoint}?query=custom`, false],
		[`${endpoint}/compact`, false],
	] as const) {
		const headers = new Headers();
		assert.equal(prepareSseBody(url, payload, headers, apiKeyMode), payload);
		assert.equal(headers.has("content-encoding"), false);
	}
	const headers = new Headers({ "content-encoding": "identity" });
	assert.equal(prepareSseBody(endpoint, payload, headers, false), payload);
	assert.equal(headers.get("content-encoding"), "identity");
	assert.equal(prepareSseBody(endpoint, "{}", new Headers(), false), "{}");
});
