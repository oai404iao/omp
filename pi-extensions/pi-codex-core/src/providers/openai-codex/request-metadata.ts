import { isUuidV7, resolveCodexRequestIdentity, uuidV7, type CodexRequestIdentity } from "@oai404iao/pi-codex-runtime/internal/codex-wire-identity";
import { buildCodexClientMetadata } from "@oai404iao/pi-codex-runtime/internal/codex-metadata";
export { buildCodexTurnMetadataJson } from "@oai404iao/pi-codex-runtime/internal/codex-metadata";
import { WS_STREAM_REQUEST_START_MS_CLIENT_METADATA_KEY } from "./constants.js";
import { type ResponsesBody, type WebSocketRequestMetadata } from "@oai404iao/pi-codex-runtime/internal/providers/openai-codex/types";

export function createCodexRequestId(): string {
	return globalThis.crypto.randomUUID();
}

export function createPiTurnId(): string {
	return uuidV7();
}

function identityForRequestMetadata(metadata: WebSocketRequestMetadata): CodexRequestIdentity | undefined {
	if (metadata.identity) return metadata.identity;
	const explicit: Record<string, unknown> = { turn_id: metadata.turnId };
	if (isUuidV7(metadata.threadId)) explicit.thread_id = metadata.threadId;
	return resolveCodexRequestIdentity(metadata.sessionId, explicit, metadata.requestKind ?? "turn");
}

export function withSseRequestMetadata(body: ResponsesBody, metadata: WebSocketRequestMetadata): ResponsesBody {
	if (metadata.codexRequestExtensions === false) return body;
	const identity = identityForRequestMetadata(metadata);
	if (!identity) return body;
	return { ...body, client_metadata: { ...body.client_metadata, ...buildCodexClientMetadata(identity) } };
}

export function withWebSocketRequestMetadata(body: ResponsesBody, metadata: WebSocketRequestMetadata): ResponsesBody {
	if (metadata.codexRequestExtensions === false) return body;
	const identity = identityForRequestMetadata(metadata);
	return {
		...body,
		client_metadata: {
			...body.client_metadata,
			...(identity ? buildCodexClientMetadata(identity) : { turn_id: metadata.turnId }),
			...(identity?.turnState ? { "x-codex-turn-state": identity.turnState } : {}),
			[WS_STREAM_REQUEST_START_MS_CLIENT_METADATA_KEY]: Date.now().toString(),
		},
	};
}
