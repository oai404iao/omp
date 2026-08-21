import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createCodexReservedNamespaceTool } from "../src/codex-reserved-tools.js";
import { rewriteNativeOpenAiTools } from "../src/provider-native-tools.js";

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function sha256(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

test("Codex reserved namespace definitions retain the reviewed Apache compatibility serialization", () => {
	const web = createCodexReservedNamespaceTool("web_search");
	const image = createCodexReservedNamespaceTool("image_generation");
	const provenance = JSON.parse(readFileSync(
		new URL("../provenance/openai-codex-eb9dceba-reserved-tools.json", import.meta.url),
		"utf8",
	));
	const webProvenance = provenance.localCompatibilitySerialization.namespaces.web_search;
	const imageProvenance = provenance.localCompatibilitySerialization.namespaces.image_generation;
	assert.equal(
		sha256(web),
		"f67597d3df3f3a77cb517646508e7305804ea029c6f8b1c1c1f241f0de0b214f",
	);
	assert.equal(
		sha256(image),
		"ccc508cff0a216bbdf368be8c98be94134a1aed0479cddd28c77d8e004f5b73e",
	);
	assert.equal(
		createHash("sha256").update(web.tools[0]!.description).digest("hex"),
		"1f3879b44690eb7aad9ba97351acda16c4d0c26847bcb4af2964d5989404407e",
	);
	assert.equal(
		createHash("sha256").update(image.tools[0]!.description).digest("hex"),
		"77a992a7c90e45fcd11623a1efa34bfd4c7870697e0aa54ce9b28f690877170e",
	);
	assert.equal(sha256(web), webProvenance.canonicalJsonSha256);
	assert.equal(sha256(web.tools[0]!.parameters), webProvenance.parameters.canonicalJsonSha256);
	assert.equal(
		createHash("sha256").update(web.tools[0]!.description).digest("hex"),
		webProvenance.description.sha256,
	);
	assert.equal(sha256(image), imageProvenance.canonicalJsonSha256);
	assert.equal(sha256(image.tools[0]!.parameters), imageProvenance.parameters.canonicalJsonSha256);
	assert.equal(
		createHash("sha256").update(image.tools[0]!.description).digest("hex"),
		imageProvenance.description.sha256,
	);
});

test("Codex reserved namespace definitions are cloned per request", () => {
	const first = createCodexReservedNamespaceTool("web_search");
	first.tools[0]!.description = "mutated";
	assert.notEqual(createCodexReservedNamespaceTool("web_search").tools[0]!.description, "mutated");
});

test("rewriteNativeOpenAiTools rewrites image_generation function tools to native Responses tools", () => {
	const payload = {
		tools: [
			{ type: "function", name: "image_generation", parameters: { output_format: "webp" } },
			{ type: "function", function: { name: "web_search", parameters: {} } },
			{ type: "function", name: "read" },
		],
	};
	const result = rewriteNativeOpenAiTools(payload, { imageModel: "gpt-image-2" });
	assert.deepEqual(result.rewritten, ["image_generation"]);
	assert.deepEqual(result.payload.tools[0], { type: "image_generation", model: "gpt-image-2", output_format: "webp", action: "auto" });
	assert.deepEqual(result.payload.tools[1], { type: "function", function: { name: "web_search", parameters: {} } });
	assert.equal((result.payload.tools[2] as any).name, "read");
});

test("rewriteNativeOpenAiTools rewrites web_search only when enabled", () => {
	const payload = { tools: [{ type: "function", name: "web_search", parameters: {} }] };
	const disabled = rewriteNativeOpenAiTools(payload, { webSearch: false });
	assert.deepEqual(disabled.rewritten, []);
	assert.deepEqual(disabled.payload.tools[0], { type: "function", name: "web_search", parameters: {} });

	const enabled = rewriteNativeOpenAiTools(payload, { webSearch: true });
	assert.deepEqual(enabled.rewritten, ["web_search"]);
	assert.deepEqual(enabled.payload.tools[0], { type: "web_search" });
});

test("rewriteNativeOpenAiTools emits Codex namespace tools for standalone profiles", () => {
	const payload = {
		tools: [
			{
				type: "function",
				name: "web_search",
				description: "Search the web",
				parameters: { type: "object", properties: {} },
			},
			{
				type: "function",
				name: "image_generation",
				description: "Generate an image",
				parameters: { type: "object", properties: { prompt: { type: "string" } } },
			},
		],
	};
	const result = rewriteNativeOpenAiTools(payload, {
		webSearch: { implementation: "standalone", contentTypes: ["text", "image"] },
		imageGeneration: "standalone",
	});
	assert.deepEqual(result.rewritten, ["web_search", "image_generation"]);
	assert.deepEqual(result.payload.tools, [
		createCodexReservedNamespaceTool("web_search"),
		createCodexReservedNamespaceTool("image_generation"),
	]);
});
