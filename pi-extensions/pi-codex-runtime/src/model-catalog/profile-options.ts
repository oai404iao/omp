import type { WebSearchProfile } from "./types.js";

function record(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function sanitizeWebSearch(value: unknown, path: string, diagnostics: string[]): false | WebSearchProfile | undefined {
	if (value === undefined || value === false) return value;
	const fail = (message: string): false => { diagnostics.push(`${path}: ${message}`); return false; };
	if (!record(value)) return fail("webSearch must be false or an object");
	const allowed = ["implementation", "contentTypes", "mode", "searchContextSize", "userLocation", "filters", "maxOutputTokens"];
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) diagnostics.push(`${path}.tools.webSearch: unknown property ${key}`);
	}
	if (value.implementation !== "hosted" && value.implementation !== "standalone") {
		return fail("webSearch.implementation must be hosted or standalone");
	}
	const result: WebSearchProfile = { implementation: value.implementation };
	if (value.contentTypes !== undefined) {
		if (!Array.isArray(value.contentTypes) || !value.contentTypes.length
			|| value.contentTypes.some(item => item !== "text" && item !== "image")) return fail("invalid webSearch contentTypes");
		result.contentTypes = [...new Set(value.contentTypes)] as ("text" | "image")[];
	}
	if (value.mode !== undefined) {
		if (value.mode !== "cached" && value.mode !== "indexed" && value.mode !== "live") return fail("invalid webSearch mode");
		result.mode = value.mode;
	}
	if (value.searchContextSize !== undefined) {
		if (!["low", "medium", "high"].includes(value.searchContextSize as string)) return fail("invalid searchContextSize");
		result.searchContextSize = value.searchContextSize as WebSearchProfile["searchContextSize"];
	}
	if (value.maxOutputTokens !== undefined) {
		if (!Number.isSafeInteger(value.maxOutputTokens) || (value.maxOutputTokens as number) <= 0) return fail("maxOutputTokens must be a positive integer");
		result.maxOutputTokens = value.maxOutputTokens as number;
	}
	if (value.userLocation !== undefined) {
		const location = value.userLocation;
		const keys = ["type", "country", "region", "city", "timezone"];
		if (!record(location) || location.type !== "approximate"
			|| Object.entries(location).some(([key, entry]) => !keys.includes(key) || typeof entry !== "string")) return fail("invalid userLocation");
		result.userLocation = location as WebSearchProfile["userLocation"];
	}
	if (value.filters !== undefined) {
		const filters = value.filters;
		if (!record(filters) || Object.keys(filters).some(key => key !== "allowedDomains")
			|| (filters.allowedDomains !== undefined && (!Array.isArray(filters.allowedDomains)
				|| filters.allowedDomains.some(domain => typeof domain !== "string" || !domain.trim())))) return fail("invalid search filters");
		result.filters = filters as WebSearchProfile["filters"];
	}
	return result;
}
