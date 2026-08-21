import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	CODEX_IDENTITY_CUSTOM_TYPE,
	ensureCodexSessionIdentity,
} from "../src/codex-identity-extension.js";
import {
	registerCodexThreadIdentity,
	resetCodexWireState,
} from "../src/codex-wire-identity.js";

class SessionFixture {
	readonly entries: SessionEntry[];

	constructor(
		readonly id: string,
		entries: SessionEntry[] = [],
	) {
		this.entries = entries;
	}

	getSessionId(): string {
		return this.id;
	}

	getSessionFile(): string | undefined {
		return undefined;
	}

	getSessionDir(): string {
		return "/tmp";
	}

	getCwd(): string {
		return "/tmp";
	}

	getEntries(): SessionEntry[] {
		return this.entries;
	}

	getBranch(): SessionEntry[] {
		return this.entries;
	}

	appendCustomEntry(customType: string, data?: unknown): string {
		const id = `entry-${this.entries.length + 1}`;
		this.entries.push({
			type: "custom",
			id,
			parentId: this.entries.at(-1)?.id ?? null,
			timestamp: new Date().toISOString(),
			customType,
			data,
		});
		return id;
	}
}

afterEach(() => {
	resetCodexWireState();
});

test("root identity is persistent and has SessionId equal to ThreadId", () => {
	const session = new SessionFixture("pi-root");
	const first = ensureCodexSessionIdentity(session);
	const resumed = ensureCodexSessionIdentity(session);
	assert.deepEqual(resumed, first);
	assert.equal(first.sessionId, first.threadId);
	assert.equal(
		session.entries.filter(
			(entry) =>
				entry.type === "custom"
				&& entry.customType === CODEX_IDENTITY_CUSTOM_TYPE,
		).length,
		1,
	);
});

test("subagent identity inherits SessionId and projects spawn lineage", () => {
	const parent = ensureCodexSessionIdentity(
		new SessionFixture("pi-parent"),
	);
	registerCodexThreadIdentity(parent);
	const child = new SessionFixture("pi-child");
	child.appendCustomEntry("pi-subagent/lineage", {
		version: 1,
		agentId: "0198e2c6-7a5b-7c20-9d1e-2f3a4b5c6d7e",
		parentAgentId: "0198e2c6-7a5b-7c21-9d1e-2f3a4b5c6d7e",
		parentPiSessionId: "pi-parent",
		relation: "spawn",
		agentName: "scout",
		openAIIdentity: true,
	});

	const identity = ensureCodexSessionIdentity(child);
	assert.equal(identity.sessionId, parent.sessionId);
	assert.notEqual(identity.threadId, parent.threadId);
	assert.equal(identity.parentThreadId, parent.threadId);
	assert.equal(identity.forkedFromThreadId, undefined);
	resetCodexWireState();
	assert.deepEqual(ensureCodexSessionIdentity(child), identity);
});

test("fork subagent records parent and forked-from independently", () => {
	const parent = ensureCodexSessionIdentity(
		new SessionFixture("pi-parent"),
	);
	const child = new SessionFixture("pi-child");
	child.appendCustomEntry("pi-subagent/lineage", {
		version: 1,
		agentId: "0198e2c6-7a5b-7c22-9d1e-2f3a4b5c6d7e",
		parentAgentId: "0198e2c6-7a5b-7c23-9d1e-2f3a4b5c6d7e",
		parentPiSessionId: "pi-parent",
		relation: "fork",
		openAIIdentity: true,
	});

	const identity = ensureCodexSessionIdentity(child);
	assert.equal(identity.sessionId, parent.sessionId);
	assert.equal(identity.parentThreadId, parent.threadId);
	assert.equal(identity.forkedFromThreadId, parent.threadId);
});

test("Pi root fork gets a new Codex tree and fork provenance", () => {
	const originalSession = new SessionFixture("pi-original");
	const original = ensureCodexSessionIdentity(originalSession);
	const copiedEntries = structuredClone(originalSession.entries);
	const fork = new SessionFixture("pi-fork", copiedEntries);

	const forkIdentity = ensureCodexSessionIdentity(fork, {
		sessionStartReason: "fork",
	});
	assert.equal(forkIdentity.sessionId, forkIdentity.threadId);
	assert.notEqual(forkIdentity.threadId, original.threadId);
	assert.equal(forkIdentity.forkedFromThreadId, original.threadId);
});
