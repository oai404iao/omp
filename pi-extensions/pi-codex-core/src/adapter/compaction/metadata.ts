import type { SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import type { CodexRequestIdentity } from "@oai404iao/pi-codex-runtime/internal/codex-wire-identity";

export function compactionMetadata(event: SessionBeforeCompactEvent): CodexRequestIdentity["compaction"] {
	if (!event.reason) return undefined;
	const last = [...event.branchEntries].reverse().find(entry => entry.type === "message");
	const message = last?.type === "message" ? last.message : undefined;
	const phase = event.reason === "manual" ? "standalone_turn"
		: event.willRetry || message?.role === "toolResult"
			|| (message?.role === "assistant" && message.stopReason === "toolUse") ? "mid_turn"
			: message?.role === "user" ? "pre_turn" : "post_turn";
	return {
		trigger: event.reason === "manual" ? "manual" : "auto",
		reason: event.reason === "manual" ? "user_requested" : "context_limit",
		implementation: "responses_compaction_v2", phase, strategy: "memento",
	};
}
