import { resolveResponsesUrl, type ResponsesProtocol } from "@oai404iao/pi-codex-runtime/internal/codex-http";

export { resolveResponsesUrl };

export function resolveResponsesWebSocketUrl(baseUrl: string | undefined, endpoint: ResponsesProtocol): string {
	const url = new URL(resolveResponsesUrl(baseUrl, endpoint));
	if (url.protocol === "https:") url.protocol = "wss:";
	if (url.protocol === "http:") url.protocol = "ws:";
	return url.toString();
}
