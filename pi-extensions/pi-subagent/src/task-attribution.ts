import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";
import { MESSAGE_CUSTOM_TYPE } from "./store.ts";
import type { SessionView } from "./providers.ts";
import type { AgentDescriptor, MailMessage } from "./types.ts";

export const CODEX_TURN_ATTRIBUTION_CHANNEL = "@oai404iao/pi-codex:turn-attribution:v1";
const CODEX_TURN_ATTRIBUTION_CUSTOM_TYPE = "pi-codex/turn-attribution";
const CODEX_LINEAGE_CUSTOM_TYPE = "pi-subagent/lineage";

export function ensureCodexLineage(session: SessionManager, parent: SessionView, descriptor: AgentDescriptor): void {
	const previous = [...session.getEntries()].reverse().find(entry =>
		entry.type === "custom" && entry.customType === CODEX_LINEAGE_CUSTOM_TYPE);
	const data = previous?.type === "custom" ? previous.data as { agentId?: string; agentPath?: string } : undefined;
	if (data?.agentId === descriptor.id && data.agentPath === descriptor.path) return;
	const parentDescriptor = [...parent.getEntries()].reverse().find(entry =>
		entry.type === "custom" && entry.customType === "pi-subagent/descriptor");
	const parentData = parentDescriptor?.type === "custom" ? parentDescriptor.data as { id?: string } : undefined;
	session.appendCustomEntry(CODEX_LINEAGE_CUSTOM_TYPE, {
		version: 1, openAIIdentity: true, agentId: descriptor.id,
		agentName: descriptor.agent.name, agentPath: descriptor.path,
		parentAgentId: parentData?.id ?? parent.getSessionId(),
		parentPiSessionId: parent.getSessionId(), parentSessionFile: parent.getSessionFile(),
		relation: descriptor.forkTurns === "all" ? "fork" : "spawn",
	});
}

export function taskMessage(pi: ExtensionAPI, from: string, to: string, text: string, sessionId: string): MailMessage {
	let codexTurnAttribution: MailMessage["codexTurnAttribution"];
	// Capture before asynchronous admission can outlive the caller's logical turn.
	pi.events.emit(CODEX_TURN_ATTRIBUTION_CHANNEL, {
		sessionId,
		accept(attribution: NonNullable<MailMessage["codexTurnAttribution"]>) {
			codexTurnAttribution = structuredClone(attribution);
		},
	});
	return {
		id: uuidv7(), from, to, kind: "task", text, createdAt: new Date().toISOString(),
		...(codexTurnAttribution ? { codexTurnAttribution } : {}),
	};
}

function firstTaskAttribution(messages: readonly MailMessage[]): MailMessage["codexTurnAttribution"] {
	return messages.find(message => message.kind === "task")?.codexTurnAttribution;
}

export function persistTaskAttribution(session: SessionManager, messages: readonly MailMessage[]): void {
	session.appendCustomEntry(CODEX_TURN_ATTRIBUTION_CUSTOM_TYPE, {
		version: 1, ...firstTaskAttribution(messages),
	});
}

export function inboxEnvelope(treeId: string, messages: readonly MailMessage[]) {
	const codexTurnAttribution = firstTaskAttribution(messages);
	return {
		customType: MESSAGE_CUSTOM_TYPE,
		content: messages.map(message =>
			`[Agent ${message.kind}: ${message.from} → ${message.to}]\n${message.text}`,
		).join("\n\n"),
		display: true,
		details: {
			treeId, messageIds: messages.map(message => message.id),
			senders: [...new Set(messages.map(message => message.from))],
			...(codexTurnAttribution ? { codexTurnAttribution } : {}),
		},
	};
}
