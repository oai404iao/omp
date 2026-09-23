import { isDeepStrictEqual } from "node:util";
import { buildSessionProjection, type SessionEntry } from "@earendil-works/pi-coding-agent";

export function continuationContext(branch: SessionEntry[], leafId = branch.at(-1)?.id) {
	return buildSessionProjection(branch, leafId).entries.flatMap(({ sourceEntry, messages }) =>
		messages.map((message, index) => ({ entryId: sourceEntry.id, index, message })),
	);
}

type Context = ReturnType<typeof continuationContext>;

export function sameContinuationContext(left: Context, right: Context): boolean {
	return isDeepStrictEqual(left, right);
}

function isEmptyAssistantError(message: Context[number]["message"]): boolean {
	return message.role === "assistant"
		&& (message.stopReason === "error" || message.stopReason === "aborted")
		&& !message.content.some((part) => part.type === "toolCall"
			|| (part.type === "text" && part.text.trim().length > 0)
			|| (part.type === "thinking" && part.thinking.trim().length > 0));
}

export function findContinuationTarget(
	branch: SessionEntry[], force: boolean,
): { target?: SessionEntry; context?: Context; reason?: string } {
	const current = continuationContext(branch);
	let toolIndex = current.length - 1;
	while (toolIndex >= 0 && current[toolIndex]!.message.role !== "toolResult") toolIndex--;
	if (toolIndex < 0) return { reason: "No model-visible tool result found to continue from." };
	const trailing = current.slice(toolIndex + 1);
	const safeTail = trailing.every(({ message }) => message.role === "system" || isEmptyAssistantError(message));
	if (!safeTail && !force) {
		return { reason: "Current branch does not end at a tool result or empty assistant error. Use /continue --force to abandon later entries." };
	}
	const desired = safeTail
		? [...current.slice(0, toolIndex + 1), ...trailing.filter(({ message }) => !isEmptyAssistantError(message))]
		: current.slice(0, toolIndex + 1);
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		// navigateTree lands on the parent for user/custom-message targets.
		if (index !== branch.length - 1 && (entry.type === "custom_message"
			|| (entry.type === "message" && entry.message.role === "user"))) continue;
		if (sameContinuationContext(continuationContext(branch, entry.id), desired)) {
			return { target: entry, context: desired };
		}
	}
	return { reason: "No safe continuation branch preserves the current context edits and compaction. --force cannot restore omitted or replaced content." };
}
