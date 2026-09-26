import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { zstdDecompressSync } from "node:zlib";
import { prepareSseBody } from "@oai404iao/pi-codex-core/internal/providers/openai-codex/request-compression";

const root = join(homedir(), ".local/state/agents/tmp");
mkdirSync(root, { recursive: true, mode: 0o700 });
const dir = mkdtempSync(join(root, "codex-compression-"));
chmodSync(dir, 0o700);
const endpoint = "https://chatgpt.com/backend-api/codex/responses";
const workloads = {
	short: ["Reply OK."],
	repeated: Array.from({ length: 128 }, (_, index) => `Turn ${index}: ${"Read the fixture and return the requested value. ".repeat(16)}`),
	mixed: Array.from({ length: 1024 }, (_, index) => createHash("sha256").update(`synthetic-${index}`).digest("hex")),
};
const rows = [];
for (const [name, texts] of Object.entries(workloads)) {
	const body = JSON.stringify({
		model: "synthetic-model", store: false, stream: true,
		input: texts.map((text) => ({ role: "user", content: [{ type: "input_text", text }] })),
	});
	const headers = new Headers();
	const encoded = prepareSseBody(endpoint, body, headers, false);
	assert.equal(typeof encoded === "string" ? encoded : zstdDecompressSync(encoded).toString(), body);
	const iterations = 50;
	for (let index = 0; index < 5; index++) prepareSseBody(endpoint, body, new Headers(), false);
	const started = performance.now();
	for (let index = 0; index < iterations; index++) prepareSseBody(endpoint, body, new Headers(), false);
	const elapsed = performance.now() - started;
	rows.push({
		name, rawBytes: Buffer.byteLength(body), wireBytes: Buffer.byteLength(encoded),
		encoding: headers.get("content-encoding") ?? "identity",
		meanEncodeMs: elapsed / iterations, iterations,
	});
}
const result = {
	node: process.version, generatedAt: new Date().toISOString(), rows,
	limits: "Synthetic in-process encode timing and bytes only; no network latency, model quality or token-cost claim.",
};
writeFileSync(join(dir, "compression.json"), JSON.stringify(result, null, 2) + "\n");
console.log(`Compression evidence: ${dir}`);
console.table(rows);
