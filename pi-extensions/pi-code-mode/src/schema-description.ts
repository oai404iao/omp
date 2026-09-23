import type { TSchema } from "typebox";

/** Display-only approximation. The unchanged JSON schema remains authoritative. */
export function schemaType(schema?: TSchema): string {
	if (!schema) return "unknown";
	let nodes = 0;
	const stack = new Set<unknown>();
	const render = (input: unknown, depth: number): string => {
		if (++nodes > 128 || depth > 8) return "unknown";
		if (input === false) return "never";
		if (!input || typeof input !== "object" || Array.isArray(input)) return "unknown";
		if (stack.has(input)) return "unknown";
		stack.add(input);
		try {
			const value = input as Record<string, unknown>;
			const type = shape(value, depth);
			const represented = new Set(["type", "properties", "required", "items", "$ref", "$defs", "definitions",
				"enum", "const", "anyOf", "oneOf", "allOf", "title", "$id", "$schema", "examples", "default"]);
			const constraints = Object.fromEntries(Object.keys(value).sort().filter((key) => !represented.has(key)).map((key) => [key, value[key]]));
			if (value.type === "integer") constraints.integer = true;
			if (!Object.keys(constraints).length) return type;
			let hint: string;
			try { hint = JSON.stringify(constraints).replace(/\*\//g, "*\\/"); }
			catch { return "unknown /* recursive schema constraints */"; }
			return hint.length <= 1024 ? `${type} /* ${hint} */` : "unknown /* schema constraints exceed display budget */";
		} finally { stack.delete(input); }
	};
	function shape(value: Record<string, unknown>, depth: number): string {
		if (typeof value.$ref === "string") {
			if (!value.$ref.startsWith("#/")) return "unknown";
			let target: unknown = schema;
			for (const part of value.$ref.slice(2).split("/").map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"))) {
				if (!target || typeof target !== "object" || !Object.hasOwn(target, part)) return "unknown";
				target = (target as Record<string, unknown>)[part];
			}
			return render(target, depth + 1);
		}
		const literal = (item: unknown) => {
			const text = JSON.stringify(item);
			return text && text.length <= 256 && (item === null || ["string", "number", "boolean"].includes(typeof item)) ? text : "unknown";
		};
		if ("const" in value) return literal(value.const);
		if (Array.isArray(value.enum)) return value.enum.length <= 24 ? value.enum.map(literal).join(" | ") || "never" : "unknown";
		for (const key of ["anyOf", "oneOf", "allOf"]) {
			if (Array.isArray(value[key])) {
				const items = value[key] as unknown[];
				return items.length <= 24 ? items.map((item) => `(${render(item, depth + 1)})`).join(key === "allOf" ? " & " : " | ") || "unknown" : "unknown";
			}
		}
		if (Array.isArray(value.type)) return value.type.map((type) => render({ ...value, type }, depth + 1)).join(" | ");
		switch (value.type) {
			case "null": return "null";
			case "boolean": return "boolean";
			case "integer": case "number": return "number";
			case "string": return "string";
			case "array": return `Array<${render(value.items, depth + 1)}>`;
			case "object": {
				const properties = value.properties && typeof value.properties === "object" && !Array.isArray(value.properties)
					? value.properties as Record<string, unknown> : {};
				const required = new Set(Array.isArray(value.required) ? value.required : []);
				const names = Object.keys(properties).sort();
				if (names.length > 64) return "Record<string, unknown>";
				const fields = names.map((key) => `${JSON.stringify(key)}${required.has(key) ? "" : "?"}: ${render(properties[key], depth + 1)}`);
				if (value.additionalProperties !== false) fields.push("[key: string]: unknown");
				return `{ ${fields.join("; ")} }`;
			}
			default: return "unknown";
		}
	}
	const result = render(schema, 0);
	return Buffer.byteLength(result) <= 4000 ? result : "unknown";
}
