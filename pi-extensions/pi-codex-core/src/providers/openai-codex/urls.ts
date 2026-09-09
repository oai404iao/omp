import { DEFAULT_CODEX_BASE_URL } from "./constants.js";

export function resolveCodexUrl(baseUrl: string | undefined, options?: { apiKeyMode?: boolean }): string {
	const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
	const normalized = raw.replace(/\/+$/, "");
	if (options?.apiKeyMode) {
		if (normalized.endsWith("/responses")) return normalized;
		return `${normalized}/responses`;
	}
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

export function resolveResponsesWebSocketUrl(baseUrl: string | undefined, options?: { apiKeyMode?: boolean }): string {
	const url = new URL(resolveCodexUrl(baseUrl, options));
	if (url.protocol === "https:") url.protocol = "wss:";
	if (url.protocol === "http:") url.protocol = "ws:";
	return url.toString();
}

export function compactUrl(baseUrl: string | undefined, apiKeyMode: boolean): string {
	return `${resolveCodexUrl(baseUrl, { apiKeyMode }).replace(/\/+$/, "")}/compact`;
}
