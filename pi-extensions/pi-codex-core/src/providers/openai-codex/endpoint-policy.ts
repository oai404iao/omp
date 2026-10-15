import { reportEndpointFailure } from "@oai404iao/pi-codex-runtime/internal/endpoint-state";
import { endpointDeclares, type EndpointCapability, type EndpointIdentity } from "@oai404iao/pi-codex-runtime/internal/endpoint-config";
import type { ResponsesBody, NativeToolOwnership } from "@oai404iao/pi-codex-runtime/internal/providers/openai-codex/types";
import { endpointWasRejected } from "@oai404iao/pi-codex-runtime/internal/endpoint-state";
import type { ResolvedCodexModelSettings } from "@oai404iao/pi-codex-runtime/internal/model-catalog/runtime";

export function assertOpaqueReplayAllowed(body: ResponsesBody, settings: { opaqueReplayAllowed?: boolean; requestBlockedReason?: string }): void {
	if (settings.opaqueReplayAllowed && !settings.requestBlockedReason) return;
	if (body.input.some(item => ["compaction", "context_compaction"].includes((item as { type?: string })?.type ?? ""))) {
		throw new Error("Opaque checkpoint preserved: native compaction/replay is disabled for the authenticated endpoint. Restore its profile/endpoint settings or navigate before compaction.");
	}
}

export function allowsTransport(
	settings: ResolvedCodexModelSettings, model: EndpointIdentity, sessionId: string | undefined, transport: "sse" | "websocket",
): boolean {
	const capability = `transport.${transport}` as const;
	return endpointDeclares(settings.endpoint_config, model, capability) && !endpointWasRejected(model, sessionId, capability);
}

export function requestTransport(
	settings: ResolvedCodexModelSettings, model: EndpointIdentity, sessionId: string | undefined,
	requested?: "auto" | "sse" | "websocket" | "websocket-cached",
) {
	const transport = !settings.webSocketEnabled ? "sse" : requested && requested !== "auto" ? requested : settings.openaiTransport;
	if (transport === "auto") {
		if (allowsTransport(settings, model, sessionId, "websocket")) return transport;
		if (allowsTransport(settings, model, sessionId, "sse")) return "sse";
	} else if (allowsTransport(settings, model, sessionId, transport === "sse" ? "sse" : "websocket")) return transport;
	throw new Error(`Responses transport ${transport} is disabled for this endpoint; no transport fallback was selected.`);
}

export function reportHostedFailure(
	model: EndpointIdentity, sessionId: string | undefined, body: ResponsesBody | undefined,
	error: unknown, owns?: NativeToolOwnership, requestCapabilities: EndpointCapability[] = [],
): boolean {
	const candidates: EndpointCapability[] = [...requestCapabilities];
	for (const tool of body?.tools ?? []) {
		const type = (tool as { type?: string })?.type;
		if (type === "web_search" && owns?.("web_search") !== false) candidates.push("webSearch.hosted");
	}
	return reportEndpointFailure(model, sessionId, candidates, error);
}
