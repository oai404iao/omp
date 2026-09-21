import { getCurrentSystemPrompt, getCurrentTools, type Context, type TranscriptContext } from "@earendil-works/pi-ai";

export function projectCodexTranscript(context: TranscriptContext): Context {
	// The pinned Codex wire formats declare a complete loadout per request,
	// rather than forwarding Pi's section patches and tool deltas.
	return {
		systemPrompt: getCurrentSystemPrompt(context.messages),
		tools: getCurrentTools(context.messages),
		messages: context.messages.filter((message) => message.role !== "system"),
	};
}
