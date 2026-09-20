import assert from "node:assert/strict";
import test from "node:test";
import { Type, type TSchema } from "typebox";
import { schemaType } from "../src/schema-description.ts";
import { toolPrompt, collect } from "../src/catalog.ts";
import { registerCodeModeTools } from "../src/contributions.ts";
import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

test("schema display: required/optional, unions, refs, cycles and complexity bounds", () => {
	const schema = Type.Object({ required: Type.String(), optional: Type.Optional(Type.Array(Type.Union([Type.Null(), Type.Integer()]))) }, { additionalProperties: false });
	assert.equal(schemaType(schema), '{ "optional"?: Array<(null) | (number /* {"integer":true} */)>; "required": string } /* {"additionalProperties":false} */');
	assert.equal(schemaType(Type.Literal("x")), '"x"');
	assert.equal(schemaType({ $defs: { entry: { type: "number" } }, $ref: "#/$defs/entry" } as TSchema), "number");
	assert.equal(schemaType({ $ref: "#/$defs/missing" } as TSchema), "unknown");
	assert.equal(schemaType({ $ref: "https://example.invalid/schema" } as TSchema), "unknown");
	const recursive = { type: "array", items: undefined as unknown };
	recursive.items = recursive;
	assert.equal(schemaType(recursive), "Array<unknown>");
	assert(schemaType(Type.Object(Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`key${i}`, Type.String()])))).length < 100);
	assert.equal(schemaType(), "unknown");
	const constrained = schemaType(Type.Object({
		id: Type.String({ pattern: "^[a-z]+$", minLength: 2, maxLength: 8 }),
		count: Type.Integer({ minimum: 1, maximum: 5 }),
	}));
	for (const text of ['"pattern":"^[a-z]+$"', '"minLength":2', '"maxLength":8', '"minimum":1', '"maximum":5', '"integer":true']) {
		assert(constrained.includes(text), `Missing model-visible constraint ${text}`);
	}
});

test("output schemas are cloned/frozen/bounded and unknown outputs are not invented", () => {
	const pi = { events: createEventBus() } as unknown as ExtensionAPI;
	const output = Type.Object({ ok: Type.Boolean() }, { additionalProperties: false });
	const registration = registerCodeModeTools(pi, { id: "fixture", tools: [{
		name: "lookup", description: "Look up something", effect: "read", parameters: Type.Object({}),
		outputSchema: output, invoke: async () => ({ value: {} }),
	}] });
	const catalog = collect(pi);
	assert.notEqual(catalog.tools[0].outputSchema, output);
	assert(Object.isFrozen(catalog.tools[0].outputSchema));
	assert.match(toolPrompt(catalog.tools), /Promise<\{ "ok": boolean \} \/\* \{"additionalProperties":false\} \*\/>/);
	const reversed = [{ ...catalog.tools[0], name: "z" }, { ...catalog.tools[0], name: "a" }];
	assert.equal(toolPrompt(reversed), toolPrompt([...reversed].reverse()));
	registration.refresh([{ ...catalog.tools[0], name: "lookup", outputSchema: undefined }]);
	assert.match(toolPrompt(collect(pi).tools), /Promise<unknown>/);
	registration.refresh([{ ...catalog.tools[0], name: "lookup", outputSchema: { description: "x".repeat(8001) } }]);
	assert.throws(() => collect(pi), /output schema/);
	registration.dispose();
});
