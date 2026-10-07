import { reportEndpointFailure } from "@oai404iao/pi-codex-runtime/internal/endpoint-state";
import type { EndpointCapability, EndpointIdentity } from "@oai404iao/pi-codex-runtime/internal/endpoint-config";
import type { ResponsesBody, NativeToolOwnership } from "@oai404iao/pi-codex-runtime/internal/providers/openai-codex/types";

export function assertOpaqueReplayAllowed(body: ResponsesBody, settings: { compactionMode: string }): void {
	if (settings.compactionMode !== "pi") return;
	if (body.input.some(item => ["compaction", "context_compaction"].includes((item as { type?: string })?.type ?? ""))) {
		throw new Error("Opaque checkpoint preserved: native compaction/replay is disabled for the authenticated endpoint. Restore its profile/endpoint settings or navigate before compaction.");
	}
}

export function reportHostedFailure(
	model: EndpointIdentity, sessionId: string | undefined, body: ResponsesBody | undefined,
	error: unknown, owns?: NativeToolOwnership,
): boolean {
	const candidates: EndpointCapability[] = [];
	for (const tool of body?.tools ?? []) {
		const type = (tool as { type?: string })?.type;
		if (type === "web_search" && owns?.("web_search") !== false) candidates.push("webSearch.hosted");
	}
	return reportEndpointFailure(model, sessionId, candidates, error);
}
