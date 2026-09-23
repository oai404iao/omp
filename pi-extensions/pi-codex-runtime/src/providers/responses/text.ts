export function shortHash(str: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < str.length; i++) {
		const ch = str.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}

export function parseStreamingJson(partialJson: string): JsonObject {
	if (!partialJson || partialJson.trim() === "") return {};
	try {
		const value: unknown = JSON.parse(partialJson);
		return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
	} catch {
		return {};
	}
}

export function sanitizeSurrogates(text: string): string {
	return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

export function localToolName(namespace: unknown, name: string): string {
	if (typeof namespace !== "string" || namespace === "" || namespace === "functions") return name;
	if (namespace === "web" && name === "run") return "web_search";
	if (namespace === "image_gen" && name === "imagegen") return "image_generation";
	return name;
}
import type { JsonObject } from "@earendil-works/pi-ai";
