import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createCodexReservedNamespaceTool } from "@oai404iao/pi-codex-runtime/internal/codex-reserved-tools";

const { localCompatibilitySerialization: { namespaces } } = JSON.parse(readFileSync(
	new URL("../provenance/openai-codex-a1604a8c-tool-declarations.json", import.meta.url), "utf8",
));

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
			.map(([key, child]) => [key, canonicalize(child)]));
	}
	return value;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const canonicalHash = (value: unknown) => sha256(JSON.stringify(canonicalize(value)));

for (const name of ["web_search", "image_generation"] as const) {
	test(`${name} declaration matches its reviewed provenance fingerprints`, () => {
		const namespace = createCodexReservedNamespaceTool(name);
		const { parameters, description } = namespace.tools[0];
		const evidence = namespaces[name];
		assert.equal(sha256(description), evidence.description.sha256);
		assert.equal(canonicalHash(parameters), evidence.parameters.canonicalJsonSha256);
		assert.equal(canonicalHash(namespace), evidence.canonicalJsonSha256);
	});
}

test("default web.run exposes neither the optional literature command nor generator-only constraints", () => {
	const { parameters } = createCodexReservedNamespaceTool("web_search").tools[0];
	assert(!Object.hasOwn(parameters.properties as object, "literature_search_query"));
	assert.doesNotMatch(JSON.stringify(parameters), /"(?:format|minimum|maxItems)":/);
});

test("image declaration advertises its reference limits and Pi execution", () => {
	const { description, parameters } = createCodexReservedNamespaceTool("image_generation").tools[0];
	const properties = parameters.properties as Record<string, Record<string, unknown>>;
	assert.equal(properties.referenced_image_paths.maxItems, 5);
	assert.equal(properties.num_last_images_to_include.minimum, 1);
	assert.equal(properties.num_last_images_to_include.maximum, 5);
	assert(!Object.hasOwn(properties, "gif"));
	assert.match(description, /await tools\.image_generation\(args\); image\(result\.image\);/);
	assert.match(description, /tools\.read/);
	assert.doesNotMatch(description, /@exec|generatedImage/);
});
