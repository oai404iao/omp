import { SessionManager } from "@earendil-works/pi-coding-agent";
import { foldDescriptor } from "./descriptor.ts";
import type { SessionView } from "./providers.ts";
import type { CatalogDiagnostic, SubagentDescriptor } from "./types.ts";

export interface PersistedDescriptor {
	id: string;
	sessionFile: string;
	descriptor: SubagentDescriptor;
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
						id: manager.getSessionId(),
						reason: "corrupt",
						sessionFile: info.path,
						...(headerParent ? { parentSessionFile: headerParent } : {}),
						message: "descriptor parentSessionFile does not match the child session header",
					});
					return;
				}
				descriptors.push({
					id: manager.getSessionId(),
					sessionFile: info.path,
					descriptor: folded.descriptor,
				});
			} else if (folded.kind === "corrupt") {
				const headerParent = manager.getHeader()?.parentSession;
				diagnostics.push({
					kind: "diagnostic",
					id: manager.getSessionId(),
					reason: "corrupt",
					sessionFile: info.path,
					...(headerParent ? { parentSessionFile: headerParent } : {}),
					message: folded.message,
				});
			}
		} catch (error) {
			diagnostics.push({
				kind: "diagnostic",
				id: info.id,
				reason: "unavailable",
				sessionFile: info.path,
				...(info.parentSessionPath ? { parentSessionFile: info.parentSessionPath } : {}),
				message: error instanceof Error ? error.message : String(error),
			});
		}
	});

	descriptors.sort(
		(left, right) =>
			left.descriptor.createdAt.localeCompare(right.descriptor.createdAt) || left.id.localeCompare(right.id),
	);
	diagnostics.sort((left, right) => left.id.localeCompare(right.id));
	return { descriptors, diagnostics };
}
