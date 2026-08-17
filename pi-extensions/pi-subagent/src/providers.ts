import { rm } from "node:fs/promises";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SubagentMode, SubagentProviderName } from "./types.ts";

export interface SessionView {
	getBranch(): SessionEntry[];
	getCwd(): string;
	getSessionDir(): string;
	getSessionFile(): string | undefined;
	getSessionId(): string;
}

export interface ProviderParent {
	sessionManager: SessionView;
}

export interface PreparedChildSession {
	sessionManager: SessionManager;
	seedMessageCount: number;
	rollback(): Promise<void>;
}

export interface ChildProvider {
	name: SubagentProviderName;
	inheritsParentContext: boolean;
	supportsContinuable: boolean;
	prepare(parent: ProviderParent, mode: SubagentMode): Promise<PreparedChildSession>;
}

async function removeOwnedSession(path: string | undefined): Promise<void> {
	if (!path) return;
	await rm(path, { force: true });
}

function freshSession(parent: ProviderParent): PreparedChildSession {
	const parentFile = parent.sessionManager.getSessionFile();
	const options = parentFile ? { parentSession: parentFile } : undefined;
	const sessionManager = parentFile
		? SessionManager.create(
				parent.sessionManager.getCwd(),
				parent.sessionManager.getSessionDir(),
				options,
			)
		: SessionManager.inMemory(parent.sessionManager.getCwd(), options);
	const childFile = sessionManager.getSessionFile();
	return {
		sessionManager,
		seedMessageCount: 0,
		rollback: () => removeOwnedSession(childFile),
	};
}

/**
 * Return the latest assistant entry that closed a completed turn.
 *
 * A tool-calling assistant message has stopReason "toolUse" and is not a safe
 * fork boundary. The current parent turn is therefore excluded.
 */
export function completedTurnBoundaryId(entries: readonly SessionEntry[]): string | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		if (entry.message.stopReason !== "toolUse") return entry.id;
	}
	return undefined;
}

function forkedSession(parent: ProviderParent): PreparedChildSession {
	const parentFile = parent.sessionManager.getSessionFile();
	const boundaryId = completedTurnBoundaryId(parent.sessionManager.getBranch());
	if (!boundaryId) return freshSession(parent);
	if (!parentFile) {
		throw new Error(
			"fork provider cannot copy completed history from an ephemeral parent session; use spawn instead",
		);
	}

	const clone = SessionManager.open(
		parentFile,
		parent.sessionManager.getSessionDir(),
		parent.sessionManager.getCwd(),
	);
	if (!clone.getEntry(boundaryId)) return freshSession(parent);
	const childFile = clone.createBranchedSession(boundaryId);
	if (!childFile) return freshSession(parent);
	const sessionManager = SessionManager.open(
		childFile,
		parent.sessionManager.getSessionDir(),
		parent.sessionManager.getCwd(),
	);
	return {
		sessionManager,
		seedMessageCount: sessionManager.buildSessionContext().messages.length,
		rollback: () => removeOwnedSession(childFile),
	};
}

export class SpawnProvider implements ChildProvider {
	readonly name = "spawn";
	readonly inheritsParentContext = false;
	readonly supportsContinuable = true;

	prepare(parent: ProviderParent, _mode: SubagentMode): Promise<PreparedChildSession> {
		return Promise.resolve(freshSession(parent));
	}
}

export class ForkProvider implements ChildProvider {
	readonly name = "fork";
	readonly inheritsParentContext = true;
	readonly supportsContinuable = false;

	async prepare(parent: ProviderParent, mode: SubagentMode): Promise<PreparedChildSession> {
		if (mode === "continuable") {
			throw new Error("fork provider is one-shot only; use spawn for continuable background work");
		}
		return forkedSession(parent);
	}
}

export class ProviderRegistry {
	private readonly providers = new Map<SubagentProviderName, ChildProvider>();

	register(provider: ChildProvider): void {
		if (this.providers.has(provider.name)) throw new Error(`duplicate subagent provider: ${provider.name}`);
		this.providers.set(provider.name, provider);
	}

	get(name: SubagentProviderName): ChildProvider {
		const provider = this.providers.get(name);
		if (!provider) throw new Error(`subagent provider is not registered: ${name}`);
		return provider;
	}

	list(): ChildProvider[] {
		return [...this.providers.values()];
	}
}
