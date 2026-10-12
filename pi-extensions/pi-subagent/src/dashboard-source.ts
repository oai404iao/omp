import { readFileSync, statSync } from "node:fs";
import { CURRENT_SESSION_VERSION, SessionManager, type AgentSession, type FileEntry, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildDashboardAgent, unavailableDashboardAgent } from "./dashboard-data.ts";
import type { DashboardSnapshot } from "./dashboard-types.ts";
import type { AgentTelemetry } from "./telemetry.ts";
import { readRunTelemetry } from "./telemetry-store.ts";
import type { AgentRecord } from "./types.ts";

interface LiveAgent {
	session: AgentSession;
	telemetry?: AgentTelemetry;
}

function readSession(record: AgentRecord): SessionManager {
	// SessionManager.open() may initialize empty files or migrate old ones.
	// Validate a private copy, then use the SDK's explicitly non-persistent loader.
	const entries: FileEntry[] = readFileSync(record.sessionFile, "utf8").split("\n")
		.filter(line => line.trim()).map(line => JSON.parse(line));
	const header = entries[0];
	if (!header || header.type !== "session" || header.version !== CURRENT_SESSION_VERSION) {
		throw new Error("Session header is missing or has an unsupported version");
	}
	const ids = new Set<string>();
	for (const entry of entries.slice(1)) {
		if (!entry || entry.type === "session" || typeof entry.id !== "string" || ids.has(entry.id) ||
			(entry.parentId !== null && !ids.has(entry.parentId)) || typeof entry.timestamp !== "string") {
			throw new Error("Session contains an invalid entry or branch");
		}
		ids.add(entry.id);
	}
	return SessionManager.inMemory(record.descriptor.cwd, undefined, entries);
}

/** Read-only cold-session cache. Called on data changes, never from render(). */
export class DashboardReader {
	private readonly cold = new Map<string, { signature: string; manager: SessionManager }>();
	private readonly timings = new Map<string, { signature: string; value: ReturnType<typeof readRunTelemetry> }>();

	clear(): void { this.cold.clear(); this.timings.clear(); }

	private timing(sessionFile: string): ReturnType<typeof readRunTelemetry> {
		try {
			const stat = statSync(`${sessionFile}.telemetry.json`);
			const signature = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
			const cached = this.timings.get(sessionFile);
			if (cached?.signature === signature) return cached.value;
			const value = readRunTelemetry(sessionFile);
			this.timings.set(sessionFile, { signature, value });
			return value;
		} catch {
			this.timings.delete(sessionFile);
			return readRunTelemetry(sessionFile);
		}
	}

	read(options: {
		records: readonly AgentRecord[];
		rootBranch: readonly SessionEntry[];
		live(path: string): LiveAgent | undefined;
		activeCount: number;
		maxConcurrentAgents: number;
	}): DashboardSnapshot {
		const records = new Map(options.records.map(record => [record.descriptor.path, record]));
		const sessions = new Map<string, SessionManager | Error>();
		const visibility = new Map<string, boolean>([["/root", true]]);
		let incomplete = false;
		const session = (record: AgentRecord): SessionManager => {
			const path = record.descriptor.path;
			const memo = sessions.get(path);
			if (memo instanceof Error) throw memo;
			if (memo) return memo;
			try {
				const live = options.live(path);
				if (live) {
					this.cold.delete(record.sessionFile);
					sessions.set(path, live.session.sessionManager);
					return live.session.sessionManager;
				}
				const stat = statSync(record.sessionFile);
				const signature = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
				let cached = this.cold.get(record.sessionFile);
				if (!cached || cached.signature !== signature) {
					cached = { signature, manager: readSession(record) };
					this.cold.set(record.sessionFile, cached);
				}
				sessions.set(path, cached.manager);
				return cached.manager;
			} catch (cause) {
				const error = cause instanceof Error ? cause : new Error(String(cause));
				sessions.set(path, error);
				throw error;
			}
		};
		const visible = (path: string): boolean => {
			const memo = visibility.get(path);
			if (memo !== undefined) return memo;
			// Break malformed cycles defensively; the normal tree store validates parent paths.
			visibility.set(path, false);
			const record = records.get(path);
			if (!record || !visible(record.descriptor.parentPath)) return false;
			try {
				const branch = record.descriptor.parentPath === "/root" ? options.rootBranch :
					session(records.get(record.descriptor.parentPath)!).getBranch();
				const result = branch.some(entry => entry.id === record.descriptor.anchorId);
				visibility.set(path, result);
				return result;
			} catch {
				incomplete = true;
				return false;
			}
		};
		const children = new Map<string, AgentRecord[]>();
		for (const record of options.records) {
			if (!visible(record.descriptor.path)) continue;
			const siblings = children.get(record.descriptor.parentPath) ?? [];
			siblings.push(record);
			children.set(record.descriptor.parentPath, siblings);
		}
		for (const siblings of children.values()) siblings.sort((a, b) =>
			a.descriptor.createdAt.localeCompare(b.descriptor.createdAt) ||
			a.descriptor.path.localeCompare(b.descriptor.path));
		const ordered: AgentRecord[] = [];
		const visit = (parent: string) => {
			for (const record of children.get(parent) ?? []) {
				ordered.push(record);
				visit(record.descriptor.path);
			}
		};
		visit("/root");
		const agents = ordered.map(record => {
			try {
				const manager = session(record);
				const timing = this.timing(record.sessionFile);
				const agent = buildDashboardAgent(record, manager.getEntries(),
					options.live(record.descriptor.path)?.telemetry?.snapshot(), manager.getBranch(), timing.records);
				if (timing.error) {
					agent.dataError = `Run timing unavailable: ${timing.error}`;
					agent.durationPartial = true;
				}
				return agent;
			} catch (error) {
				return unavailableDashboardAgent(record, error instanceof Error ? error.message : String(error));
			}
		});
		return {
			agents, activeCount: options.activeCount, maxConcurrentAgents: options.maxConcurrentAgents,
			...(incomplete ? { error: "Some descendants are hidden because their parent session could not be read." } : {}),
		};
	}
}
