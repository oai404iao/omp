import {
	closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { uuidv7 } from "@earendil-works/pi-ai";
import { DESCRIPTOR_VERSION, type AgentRecord, type MailMessage } from "./types.ts";
import { resolveTaskPath } from "./task-path.ts";

export const TREE_VERSION = 1;
export const TREE_CUSTOM_TYPE = "pi-subagent/tree-v2";
export const REGISTRATION_CUSTOM_TYPE = "pi-subagent/registration-v2";
export const MESSAGE_CUSTOM_TYPE = "pi-subagent/message-v2";
export const DESCRIPTOR_CUSTOM_TYPE = "pi-subagent/descriptor";
export const MAX_PENDING_MESSAGES = 256;
export const MAX_PENDING_BYTES = 256 * 1024;

export interface TreeState {
	version: typeof TREE_VERSION;
	id: string;
	rootSessionId: string;
	rootMailbox: MailMessage[];
	agents: Record<string, AgentRecord>;
}

function validateState(value: unknown, id: string, rootSessionId: string): asserts value is TreeState {
	const state = value as TreeState;
	if (!state || state.version !== TREE_VERSION || state.id !== id ||
		state.rootSessionId !== rootSessionId || !Array.isArray(state.rootMailbox) ||
		!state.agents || typeof state.agents !== "object" || Array.isArray(state.agents)) {
		throw new Error("unsupported or corrupt subagent tree store");
	}
	const statuses = new Set(["pending_init", "running", "completed", "interrupted", "errored"]);
	for (const [path, record] of Object.entries(state.agents)) {
		if (resolveTaskPath("/root", path) !== path || path === "/root" ||
			record.descriptor?.version !== DESCRIPTOR_VERSION || record.descriptor.path !== path ||
			!statuses.has(record.status) || typeof record.sessionFile !== "string" ||
			!Array.isArray(record.mailbox) || !record.descriptor.anchorId ||
			path.slice(0, path.lastIndexOf("/")) !== record.descriptor.parentPath) {
			throw new Error(`unsupported or corrupt subagent descriptor: ${path}`);
		}
	}
	for (const [path, messages] of [
		["/root", state.rootMailbox] as const,
		...Object.entries(state.agents).map(([path, record]) => [path, record.mailbox] as const),
	]) {
		for (const message of messages) {
			if (!message || typeof message.id !== "string" || typeof message.text !== "string" ||
				message.to !== path || !["message", "task", "completion"].includes(message.kind) ||
				typeof message.from !== "string") throw new Error("corrupt subagent mailbox");
		}
	}
}

/** Atomic control snapshots, independent of SDK transcript creation/flush timing. */
export class TreeStore {
	readonly directory: string;
	readonly sessionDirectory: string;
	private readonly file: string;
	private state: TreeState;

	constructor(sessionDirectory: string, id: string, rootSessionId: string) {
		if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("invalid subagent tree identity");
		this.directory = join(sessionDirectory, `${rootSessionId}.subagents`, id);
		this.sessionDirectory = join(this.directory, "sessions");
		mkdirSync(this.sessionDirectory, { recursive: true, mode: 0o700 });
		this.file = join(this.directory, "state.json");
		if (existsSync(this.file)) {
			const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
			validateState(parsed, id, rootSessionId);
			this.state = parsed;
		} else {
			this.state = { version: TREE_VERSION, id, rootSessionId, rootMailbox: [], agents: {} };
			this.update(() => {});
		}
	}

	get snapshot(): Readonly<TreeState> { return this.state; }
	record(path: string): AgentRecord {
		const record = this.state.agents[path];
		if (!record) throw new Error(`unknown agent: ${path}`);
		return record;
	}
	mailbox(path: string): readonly MailMessage[] {
		return path === "/root" ? this.state.rootMailbox : this.record(path).mailbox;
	}
	update(change: (draft: TreeState) => void): void {
		const next = structuredClone(this.state);
		change(next);
		// Failed writes must not advance the in-memory state. Retained staging files
		// are machine-local recovery artifacts, never configuration or source files.
		const staging = join(this.directory, `state-${uuidv7()}.pending`);
		const fd = openSync(staging, "wx", 0o600);
		try {
			writeFileSync(fd, JSON.stringify(next) + "\n");
			fsyncSync(fd);
		} finally { closeSync(fd); }
		renameSync(staging, this.file);
		const dir = openSync(this.directory, "r");
		try { fsyncSync(dir); } finally { closeSync(dir); }
		this.state = next;
	}
	enqueue(message: MailMessage): void {
		this.update(state => enqueueInState(state, message));
	}
	acknowledge(path: string, ids: ReadonlySet<string>): void {
		if (!this.mailbox(path).some(message => ids.has(message.id))) return;
		this.update(state => {
			if (path === "/root") state.rootMailbox = state.rootMailbox.filter(message => !ids.has(message.id));
			else state.agents[path]!.mailbox = state.agents[path]!.mailbox.filter(message => !ids.has(message.id));
		});
	}
}

export function enqueueInState(state: TreeState, message: MailMessage): void {
	const mailbox = message.to === "/root" ? state.rootMailbox : state.agents[message.to]?.mailbox;
	if (!mailbox) throw new Error(`unknown agent: ${message.to}`);
	if (mailbox.some(existing => existing.id === message.id)) return;
	if (mailbox.length >= MAX_PENDING_MESSAGES ||
		mailbox.reduce((bytes, entry) => bytes + Buffer.byteLength(entry.text), 0) +
		Buffer.byteLength(message.text) > MAX_PENDING_BYTES) {
		throw new Error(`mailbox capacity reached for ${message.to}`);
	}
	mailbox.push(message);
}
