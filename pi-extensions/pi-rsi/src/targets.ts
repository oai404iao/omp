import type { SessionEntry, SessionMessageEntry, SessionTreeNode } from "@earendil-works/pi-coding-agent";
import type { FeedbackRecord } from "./feedback.ts";

export type Target = Pick<FeedbackRecord, "userMessageEntryId" | "finalAssistantEntryId">;

function isUser(entry: SessionEntry): boolean {
	return entry.type === "message" && entry.message.role === "user";
}

type Outcome = SessionMessageEntry | null;
interface PathState {
	outcome: Outcome;
	afterCustom: boolean;
}
const initial: PathState = { outcome: null, afterCustom: false };

function advance(state: PathState, entry: SessionEntry): PathState {
	// Pi persists both injected context and independently triggered custom turns this way.
	// The entry alone keeps the preceding outcome; a later assistant is ambiguous.
	if (entry.type === "custom_message" || (entry.type === "message" && entry.message.role === "custom")) {
		return { ...state, afterCustom: true };
	}
	if (entry.type !== "message") return state;
	const msg = entry.message;
	if (msg.role === "toolResult") return { ...state, outcome: null };
	if (msg.role !== "assistant") return state;
	let outcome: Outcome = null;
	if (!state.afterCustom) {
		const hasText = msg.content.some(block => block.type === "text" && block.text.trim());
		if (msg.stopReason === "error" && (msg.errorMessage?.trim() || hasText)) outcome = entry;
		if ((msg.stopReason === "stop" || msg.stopReason === "length") && hasText && !msg.content.some(block => block.type === "toolCall")) {
			outcome = entry;
		}
	}
	return { ...state, outcome };
}

export function latestTarget(branch: SessionEntry[], idle: boolean): Target | undefined {
	const index = branch.findLastIndex(isUser);
	if (index === -1) return undefined;
	let state = initial;
	if (idle) {
		for (let i = index + 1; i < branch.length; i++) state = advance(state, branch[i]);
	}
	return { userMessageEntryId: branch[index].id, finalAssistantEntryId: state.outcome?.id ?? null };
}

export function historyOutcomes(user: SessionTreeNode, activeLeafId: string | null, idle: boolean): Outcome[] {
	if (!isUser(user.entry)) return [];
	const outcomes = new Set<Outcome>();
	const stack = [{ node: user, state: initial }];
	while (stack.length) {
		const { node, state } = stack.pop()!;
		const active = node.entry.id === activeLeafId;
		// Navigation can leave the active pointer at an internal node. Its old children
		// still represent distinct, historical paths, even if that pointer is now busy.
		if (active || !node.children.length) outcomes.add(active && !idle ? null : state.outcome);
		for (let i = node.children.length - 1; i >= 0; i--) {
			const child = node.children[i];
			if (isUser(child.entry)) outcomes.add(state.outcome);
			else stack.push({ node: child, state: advance(state, child.entry) });
		}
	}
	return [...outcomes];
}
