import { readFileSync, statSync } from "node:fs";
import { CURRENT_SESSION_VERSION, SessionManager, type AgentSession, type FileEntry, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildDashboardAgent, unavailableDashboardAgent } from "./dashboard-data.ts";
import type { DashboardSnapshot, TranscriptSnapshot } from "./dashboard-types.ts";
import { buildTranscript } from "./transcript-data.ts";
import { createTranscriptPresentation } from "./transcript-presentation.ts";
import type { AgentTelemetry } from "./telemetry.ts";
import { readRunTelemetry } from "./telemetry-store.ts";
import type { AgentRecord } from "./types.ts";

interface LiveAgent {
	session: AgentSession;
	telemetry?: AgentTelemetry;
}

interface ReaderOptions {
	records: readonly AgentRecord[];
	rootBranch: readonly SessionEntry[];
	live(path: string): LiveAgent | undefined;
}

export function readSession(record: AgentRecord): SessionManager {
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

	private session(record: AgentRecord, live?: LiveAgent): SessionManager {
		if (live) {
			this.cold.delete(record.sessionFile);
			return live.session.sessionManager;
		}
		const stat = statSync(record.sessionFile);
		const signature = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
		let cached = this.cold.get(record.sessionFile);
		if (!cached || cached.signature !== signature) {
			cached = { signature, manager: readSession(record) };
			this.cold.set(record.sessionFile, cached);
		}
		return cached.manager;
	}

	transcript(path: string, options: ReaderOptions, before?: string): TranscriptSnapshot {
		const records = new Map(options.records.map(record => [record.descriptor.path, record]));
		const record = records.get(path);
		const unavailable = (error: string): TranscriptSnapshot => ({
			path, status: record?.status ?? "interrupted", entries: [], inheritedCount: 0, error,
		});
		if (!record) return unavailable("Agent is not in the current tree.");
		const seen = new Set<string>();
		const visible = (target: AgentRecord): boolean => {
			if (seen.has(target.descriptor.path)) return false;
			seen.add(target.descriptor.path);
			const parentPath = target.descriptor.parentPath;
			const parent = records.get(parentPath);
			if (parentPath !== "/root" && (!parent || !visible(parent))) return false;
			const branch = parentPath === "/root" ? options.rootBranch :
				this.session(parent!, options.live(parentPath)).getBranch();
			return branch.some(entry => entry.id === target.descriptor.anchorId);
		};
		try {
			if (!visible(record)) return unavailable("Agent is not visible on the current canonical branch.");
			const live = options.live(path);
			const manager = this.session(record, live);
			return {
				...buildTranscript(record, manager.getBranch(), live?.telemetry?.transcriptSnapshot(), before),
				presentation: createTranscriptPresentation(record.descriptor.cwd, live?.session),
			};
		} catch (error) {
			return unavailable(error instanceof Error ? error.message : String(error));
		}
	}

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

	read(options: ReaderOptions & {
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
				const manager = this.session(record, options.live(path));
				sessions.set(path, manager);
				return manager;
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
			const live = options.live(record.descriptor.path);
			const selected = live ? {
				...(live.session.model ? { model: `${live.session.model.provider}/${live.session.model.id}` } : {}),
				thinkingLevel: live.session.thinkingLevel,
			} : {};
			try {
				const manager = session(record);
				const timing = this.timing(record.sessionFile);
				const agent = buildDashboardAgent(record, manager.getEntries(),
					live?.telemetry?.snapshot(), manager.getBranch(), timing.records);
				if (timing.error) {
					agent.dataError = `Run timing unavailable: ${timing.error}`;
					agent.durationPartial = true;
				}
				return { ...agent, ...selected };
			} catch (error) {
				return { ...unavailableDashboardAgent(record, error instanceof Error ? error.message : String(error)), ...selected };
			}
		});
		return {
			agents, activeCount: options.activeCount, maxConcurrentAgents: options.maxConcurrentAgents,
			...(incomplete ? { error: "Some descendants are hidden because their parent session could not be read." } : {}),
		};
	}
}
