import { SessionManager } from "@earendil-works/pi-coding-agent";
import { foldDescriptor } from "./descriptor.ts";
import {
	foldCompletionMailbox,
	unreadCompletionCounts,
} from "./completion-mailbox.ts";
import { foldOwnedMailbox } from "./mailbox.ts";
import type { SessionView } from "./providers.ts";
import type { CatalogDiagnostic, SubagentDescriptor } from "./types.ts";

export interface PersistedDescriptor {
	agentId: string;
	sessionFile: string;
	descriptor: SubagentDescriptor;
	pendingMessages: number;
	unreadUpdatesByChild: Map<string, number>;
}

export interface PersistedCatalog {
	descriptors: PersistedDescriptor[];
	diagnostics: CatalogDiagnostic[];
}

async function mapWithConcurrency<T>(
	items: readonly T[],
	limit: number,
	visit: (item: T) => Promise<void>,
): Promise<void> {
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (true) {
			const index = next++;
			if (index >= items.length) return;
			await visit(items[index]);
		}
	});
	await Promise.all(workers);
}

export async function readPersistedCatalog(session: SessionView): Promise<PersistedCatalog> {
	const descriptors: PersistedDescriptor[] = [];
	const diagnostics: CatalogDiagnostic[] = [];
	const sessions = await SessionManager.list(session.getCwd(), session.getSessionDir());

	await mapWithConcurrency(sessions, 8, async (info) => {
		try {
			const manager = SessionManager.open(info.path, session.getSessionDir(), session.getCwd());
			const folded = foldDescriptor(manager.getEntries());
			if (folded.kind === "valid") {
				const headerParent = manager.getHeader()?.parentSession;
				if (headerParent !== folded.descriptor.parentSessionFile) {
					diagnostics.push({
						kind: "diagnostic",
						piSessionId: manager.getSessionId(),
						reason: "corrupt",
						sessionFile: info.path,
						...(headerParent ? { parentSessionFile: headerParent } : {}),
						message: "descriptor parentSessionFile does not match the child session header",
					});
					return;
				}
				let pendingMessages = 0;
				if (folded.descriptor.runtime.backgroundProtocol === "mailbox-v2") {
					const mailbox = foldOwnedMailbox(manager.getEntries(), {
						parentAgentId: folded.descriptor.parentAgentId,
						agentId: folded.descriptor.agentId,
					});
					if (mailbox.kind === "corrupt") {
						diagnostics.push({
							kind: "diagnostic",
							piSessionId: manager.getSessionId(),
							reason: "corrupt",
							sessionFile: info.path,
							...(headerParent ? { parentSessionFile: headerParent } : {}),
							message: `corrupt subagent mailbox: ${mailbox.message}`,
						});
						return;
					}
					pendingMessages = mailbox.snapshot.pending.length;
				}
				let unreadUpdatesByChild = new Map<string, number>();
				const completions = foldCompletionMailbox(
					manager.getEntries(),
					{ parentAgentId: folded.descriptor.agentId },
				);
				if (completions.kind === "corrupt") {
					diagnostics.push({
						kind: "diagnostic",
						piSessionId: manager.getSessionId(),
						reason: "corrupt",
						sessionFile: info.path,
						...(headerParent ? { parentSessionFile: headerParent } : {}),
						message: `corrupt completion mailbox: ${completions.message}`,
					});
				} else {
					unreadUpdatesByChild = unreadCompletionCounts(
						completions.snapshot,
					);
				}
				descriptors.push({
					agentId: folded.descriptor.agentId,
					sessionFile: info.path,
					descriptor: folded.descriptor,
					pendingMessages,
					unreadUpdatesByChild,
				});
			} else if (folded.kind === "corrupt") {
				const headerParent = manager.getHeader()?.parentSession;
				diagnostics.push({
					kind: "diagnostic",
					piSessionId: manager.getSessionId(),
					reason: "corrupt",
					sessionFile: info.path,
					...(headerParent ? { parentSessionFile: headerParent } : {}),
					message: folded.message,
				});
			}
		} catch (error) {
			diagnostics.push({
				kind: "diagnostic",
				piSessionId: info.id,
				reason: "unavailable",
				sessionFile: info.path,
				...(info.parentSessionPath ? { parentSessionFile: info.parentSessionPath } : {}),
				message: error instanceof Error ? error.message : String(error),
			});
		}
	});

	descriptors.sort(
		(left, right) =>
			left.descriptor.createdAt.localeCompare(right.descriptor.createdAt) ||
			left.agentId.localeCompare(right.agentId),
	);
	diagnostics.sort((left, right) =>
		left.piSessionId.localeCompare(right.piSessionId),
	);
	return { descriptors, diagnostics };
}
