import { createHash } from "node:crypto";

const UUID_OID_NAMESPACE = "6ba7b812-9dad-11d1-80b4-00c04fd430c8";

function uuidV5(namespace: string, value: string): string {
	const bytes = createHash("sha1")
		.update(Buffer.from(namespace.replaceAll("-", ""), "hex"))
		.update(value, "utf8").digest().subarray(0, 16);
	bytes[6] = (bytes[6]! & 0x0f) | 0x50;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function serdeJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(serdeJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value).filter(([, entry]) => entry !== undefined)
			.sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
			.map(([key, entry]) => `${JSON.stringify(key)}:${serdeJson(entry)}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/** Codex hashes serde_json::Value tools (sorted keys) within the thread's OID namespace. */
export function requestPrefix(threadId: string | undefined, instructions: string | undefined, tools?: unknown[]): unknown[] {
	const namespace = threadId ? uuidV5(UUID_OID_NAMESPACE, threadId) : undefined;
	const prefix: unknown[] = [];
	if (tools?.length) prefix.push({
		type: "additional_tools",
		...(namespace ? { id: `at_${uuidV5(namespace, serdeJson(tools))}` } : {}),
		role: "developer", tools,
	});
	if (instructions) prefix.push({
		type: "message",
		...(namespace ? { id: `msg_${uuidV5(namespace, instructions)}` } : {}),
		role: "developer", content: [{ type: "input_text", text: instructions }],
	});
	return prefix;
}

export function isBasePrewarmInput(input: unknown[]): boolean {
	if (input.length > 2) return false;
	let instructions = false;
	return input.every((item, index) => {
		if (!item || typeof item !== "object") return false;
		const value = item as Record<string, unknown>;
		if (value.role !== "developer") return false;
		if (value.type === "additional_tools") return index === 0 && Array.isArray(value.tools) && value.tools.length > 0;
		if (instructions) return false;
		instructions = true;
		return value.type === "message" && Array.isArray(value.content)
			&& value.content.every(part => !!part && typeof part === "object"
				&& (part as Record<string, unknown>).type === "input_text");
	});
}
