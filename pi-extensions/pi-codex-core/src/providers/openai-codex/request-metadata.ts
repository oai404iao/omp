import { isUuidV7, resolveCodexRequestIdentity, uuidV7, type CodexRequestIdentity } from "@oai404iao/pi-codex-runtime/internal/codex-wire-identity";
import { WS_STREAM_REQUEST_START_MS_CLIENT_METADATA_KEY } from "./constants.js";
import { type ResponsesBody, type WebSocketRequestMetadata } from "@oai404iao/pi-codex-runtime/internal/providers/openai-codex/types";

export function createCodexRequestId(): string {
	if (typeof globalThis.crypto?.randomUUID === "function") {
		return globalThis.crypto.randomUUID();
	}
	return `codex_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createPiTurnId(): string {
	return uuidV7();
}

/**
 * Build the `x-codex-turn-metadata` compatibility blob the CLI sends inside
 * `client_metadata` for every request kind. The gateway currently rewrites
 * this blob (privacy normalization); once it honors client-supplied values,
 * this keeps the shape identical to the CLI.
 */
export function buildCodexTurnMetadataJson(identity: CodexRequestIdentity): string {
	const payload: Record<string, string | number> = {
		installation_id: identity.installationId,
		session_id: identity.sessionId,
		thread_id: identity.threadId,
		turn_id: identity.turnId,
		window_id: identity.windowId,
		request_kind: identity.requestKind,
		...(identity.turnStartedAtMs !== undefined
			? { turn_started_at_unix_ms: identity.turnStartedAtMs }
			: {}),
		...(identity.agentName ? { agent_name: identity.agentName } : {}),
		...(identity.forkedFromThreadId
			? { forked_from_thread_id: identity.forkedFromThreadId }
			: {}),
		...(identity.parentThreadId
			? { parent_thread_id: identity.parentThreadId }
			: {}),
		...(identity.parentTurnId
			? { parent_turn_id: identity.parentTurnId }
			: {}),
		...(identity.rootTurnId
			? { root_turn_id: identity.rootTurnId }
			: {}),
		...(identity.subagentKind
			? { subagent_kind: identity.subagentKind }
			: {}),
	};
	return JSON.stringify(payload);
}

function identityForRequestMetadata(
	metadata: WebSocketRequestMetadata,
): CodexRequestIdentity | undefined {
	if (metadata.identity) return metadata.identity;
	const explicit: Record<string, unknown> = {
		turn_id: metadata.turnId,
	};
	if (isUuidV7(metadata.threadId)) explicit.thread_id = metadata.threadId;
	return resolveCodexRequestIdentity(
		metadata.sessionId,
		explicit,
		metadata.requestKind ?? "turn",
	);
}

/**
 * Inject the Codex-compatible `client_metadata` for an SSE request, sourced
 * from the same (session, thread, turn) metadata as the WebSocket path. The
 * WebSocket-only fields (`x-codex-ws-stream-request-start-ms`, turn-state,
 * Lite flag) stay out: SSE carries the Lite header and turn-state header.
 */
export function withSseRequestMetadata(body: ResponsesBody, metadata: WebSocketRequestMetadata): ResponsesBody {
	const identity = identityForRequestMetadata(metadata);
	if (!identity) return body;
	const turnMetadata = buildCodexTurnMetadataJson(identity);
	return {
		...body,
		client_metadata: {
			...body.client_metadata,
			session_id: identity.sessionId,
			thread_id: identity.threadId,
			"x-codex-window-id": identity.windowId,
			turn_id: identity.turnId,
			"x-codex-installation-id": identity.installationId,
			...(identity.parentThreadId
				? { "x-codex-parent-thread-id": identity.parentThreadId }
				: {}),
			...(identity.parentTurnId
				? { parent_turn_id: identity.parentTurnId }
				: {}),
			...(identity.rootTurnId
				? { root_turn_id: identity.rootTurnId }
				: {}),
			...(identity.subagentKind
				? { "x-openai-subagent": identity.subagentKind }
				: {}),
			...(turnMetadata ? { "x-codex-turn-metadata": turnMetadata } : {}),
		},
	};
}

export function withWebSocketRequestMetadata(body: ResponsesBody, metadata: WebSocketRequestMetadata): ResponsesBody {
	const identity = identityForRequestMetadata(metadata);
	const turnMetadata = identity ? buildCodexTurnMetadataJson(identity) : "";
	return {
		...body,
		client_metadata: {
			...body.client_metadata,
			...(identity ? { session_id: identity.sessionId } : {}),
			...(identity ? { thread_id: identity.threadId } : {}),
			...(identity ? { "x-codex-window-id": identity.windowId } : {}),
			turn_id: identity?.turnId ?? metadata.turnId,
			...(identity
				? { "x-codex-installation-id": identity.installationId }
				: {}),
			...(identity?.parentThreadId
				? { "x-codex-parent-thread-id": identity.parentThreadId }
				: {}),
			...(identity?.parentTurnId
				? { parent_turn_id: identity.parentTurnId }
				: {}),
			...(identity?.rootTurnId
				? { root_turn_id: identity.rootTurnId }
				: {}),
			...(identity?.subagentKind
				? { "x-openai-subagent": identity.subagentKind }
				: {}),
			...(turnMetadata ? { "x-codex-turn-metadata": turnMetadata } : {}),
			...(identity?.turnState
				? { "x-codex-turn-state": identity.turnState }
				: {}),
			[WS_STREAM_REQUEST_START_MS_CLIENT_METADATA_KEY]: Date.now().toString(),
		},
	};
}
