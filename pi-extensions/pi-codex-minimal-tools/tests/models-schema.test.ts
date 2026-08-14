import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

type SchemaNode = {
	[key: string]: unknown;
};

const schema = JSON.parse(
	readFileSync(new URL("../models.schema.json", import.meta.url), "utf8"),
) as SchemaNode;

function propertySchema(path: string[]): SchemaNode {
	let current: unknown = schema;
	for (const segment of path) {
		assert.ok(current && typeof current === "object" && !Array.isArray(current));
		current = (current as SchemaNode)[segment];
	}
	assert.ok(current && typeof current === "object" && !Array.isArray(current));
	return current as SchemaNode;
}

function containsKey(value: unknown, key: string): boolean {
	if (!value || typeof value !== "object") return false;
	if (Array.isArray(value)) return value.some((item) => containsKey(item, key));
	const record = value as SchemaNode;
	return Object.hasOwn(record, key)
		|| Object.values(record).some((item) => containsKey(item, key));
}

test("model schema avoids oneOf so JSON LSPs can offer every value completion", () => {
	assert.equal(containsKey(schema, "oneOf"), false);

	const tools = ["$defs", "model", "properties", "tools", "properties"];
	assert.deepEqual(
		propertySchema([...tools, "applyPatch"]).enum,
		[false, "function", "custom"],
	);
	assert.deepEqual(
		propertySchema([...tools, "imageGeneration"]).enum,
		[false, "hosted", "standalone"],
	);

	const webSearch = propertySchema([...tools, "webSearch"]);
	assert.deepEqual(webSearch.if, { type: "boolean" });
	assert.deepEqual(webSearch.then, { const: false });
	assert.deepEqual(webSearch.else, { type: "object" });
	assert.deepEqual(
		(webSearch.defaultSnippets as Array<{ body: unknown }>).map(({ body }) => body),
		[
			false,
			{ implementation: "hosted" },
			{ implementation: "standalone" },
		],
	);

	const fast = propertySchema(["$defs", "model", "properties", "fast"]);
	assert.deepEqual(fast.if, { type: "boolean" });
	assert.deepEqual(fast.then, { const: false });
	assert.deepEqual(fast.else, { type: "object" });
	assert.deepEqual(
		(fast.defaultSnippets as Array<{ body: unknown }>).map(({ body }) => body),
		[false, { serviceTier: "priority" }],
	);
});
