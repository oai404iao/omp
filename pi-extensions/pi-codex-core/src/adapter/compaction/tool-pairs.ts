import type { SessionContext } from "@earendil-works/pi-coding-agent";

type PiMessage = SessionContext["messages"][number];

/** Native checkpoints can split a tool turn: pair outputs, drop orphans, and
 * terminate surviving calls without results before sending another request. */
export function normalizeNativeCompactionToolPairs(messages: PiMessage[]): PiMessage[] {
	const resultByCallId = new Map<string, Extract<PiMessage, { role: "toolResult" }>>();
	for (const message of messages) {
		if (message.role === "toolResult" && !resultByCallId.has(message.toolCallId)) {
			resultByCallId.set(message.toolCallId, message);
		}
	}
	let changed = false;
	const normalized: PiMessage[] = [];
	const retainedResults = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult") {
			changed = true;
			continue;
		}
		normalized.push(message);
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall" || retainedResults.has(block.id)) continue;
			retainedResults.add(block.id);
			const existing = resultByCallId.get(block.id);
			if (existing) {
				normalized.push(existing);
				continue;
			}
			changed = true;
			normalized.push({
				role: "toolResult",
				toolCallId: block.id,
				toolName: block.name,
				content: [{ type: "text", text: "aborted" }],
				isError: true,
				timestamp: typeof message.timestamp === "number" ? message.timestamp : 0,
			} as PiMessage);
		}
	}
	if (retainedResults.size !== resultByCallId.size) changed = true;
	return changed ? normalized : messages;
}
