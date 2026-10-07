import type { CodexRequestIdentity } from "./codex-identity-types.js";

export function asciiJson(value: unknown): string {
	return JSON.stringify(value).replace(/[\u007f-\uffff]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function buildCodexTurnMetadata(identity: CodexRequestIdentity): Record<string, unknown> {
	return {
		installation_id: identity.installationId,
		session_id: identity.sessionId,
		thread_id: identity.threadId,
		turn_id: identity.turnId,
		window_id: identity.windowId,
		window_number: identity.windowNumber,
		context_window_id: identity.contextWindowId,
		request_kind: identity.requestKind,
		...(identity.turnStartedAtMs !== undefined ? { turn_started_at_unix_ms: identity.turnStartedAtMs } : {}),
		...(identity.agentName ? { agent_name: identity.agentName } : {}),
		...(!identity.parentThreadId && identity.forkedFromThreadId ? { forked_from_thread_id: identity.forkedFromThreadId } : {}),
		...(identity.parentThreadId ? { parent_thread_id: identity.parentThreadId } : {}),
		...(identity.parentTurnId ? { parent_turn_id: identity.parentTurnId } : {}),
		...(identity.rootTurnId ? { root_turn_id: identity.rootTurnId } : {}),
		...(identity.subagentKind ? { subagent_kind: identity.subagentKind } : {}),
		...(identity.model ? { model: identity.model } : {}),
		...(identity.reasoningEffort ? { reasoning_effort: identity.reasoningEffort } : {}),
		...(identity.requestKind === "compaction" && identity.compaction ? { compaction: identity.compaction } : {}),
	};
}

export function buildCodexTurnMetadataJson(identity: CodexRequestIdentity): string {
	return asciiJson(buildCodexTurnMetadata(identity));
}
export function buildCodexCompatibilityMetadataJson(identity: CodexRequestIdentity): string {
	return buildCodexTurnMetadataJson(identity);
}
export function buildCodexClientMetadata(identity: CodexRequestIdentity): Record<string, string> {
	return {
		"x-codex-installation-id": identity.installationId,
		session_id: identity.sessionId, thread_id: identity.threadId,
		"x-codex-window-id": identity.windowId,
		turn_id: identity.turnId,
		...(identity.parentThreadId ? { "x-codex-parent-thread-id": identity.parentThreadId } : {}),
		...(identity.subagentHeader ? { "x-openai-subagent": identity.subagentHeader } : {}),
		...(identity.parentTurnId ? { parent_turn_id: identity.parentTurnId } : {}),
		...(identity.rootTurnId ? { root_turn_id: identity.rootTurnId } : {}),
		"x-codex-turn-metadata": buildCodexTurnMetadataJson(identity),
	};
}
export function buildCodexExternalToolMetadataJson(identity: CodexRequestIdentity): string {
	return asciiJson({
		session_id: identity.sessionId, thread_id: identity.threadId, turn_id: identity.turnId,
		...(identity.parentThreadId ? { parent_thread_id: identity.parentThreadId } : {}),
		...(identity.forkedFromThreadId ? { forked_from_thread_id: identity.forkedFromThreadId } : {}),
		...(identity.subagentKind ? { subagent_kind: identity.subagentKind } : {}),
		...(identity.turnStartedAtMs !== undefined ? { turn_started_at_unix_ms: identity.turnStartedAtMs } : {}),
		...(identity.model ? { model: identity.model } : {}),
		...(identity.reasoningEffort ? { reasoning_effort: identity.reasoningEffort } : {}),
	});
}
