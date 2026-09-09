import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { DESCRIPTOR_CUSTOM_TYPE, foldDescriptor, parseDescriptor } from "../src/descriptor.ts";
import type { SubagentDescriptor } from "../src/types.ts";

function descriptor(label = "inspect auth"): SubagentDescriptor {
	return {
		version: 2,
		mode: "continuable",
		provider: "spawn",
		label,
		agentId: "01900000-0000-7000-8000-000000000000",
		parentAgentId: "018fffff-ffff-7000-8000-000000000000",
		parentPiSessionId: "pi-parent-session",
		parentSessionFile: "/tmp/parent.jsonl",
		depth: 1,
		cwd: "/tmp/project",
		createdAt: "2026-01-01T00:00:00.000Z",
		agent: {
			name: "scout",
			description: "Scout",
			tools: ["read", "grep"],
			thinking: "low",
			systemPrompt: "Inspect.",
			source: "user",
		},
		model: { provider: "openai", id: "gpt-5" },
		thinkingLevel: "low",
		runtime: {
			agentScope: "user",
			maxDepth: 3,
			enableRunInBackground: true,
			defaultBackground: true,
			maxConcurrentBackgroundRuns: 4,
			maxIdleRuntimes: 0,
			backgroundProtocol: "legacy",
			reportDelivery: "wakeup",
			inheritExtensions: false,
			openAIIdentity: false,
			maxOutputBytes: 51200,
		},
	};
}

function currentDescriptor(): SubagentDescriptor {
	const legacy = descriptor();
	return {
		...legacy,
		version: 3,
		task: {
			name: "inspect-auth",
			path: "/root/inspect-auth",
		},
		context: {
			mode: "last_n_completed",
			completedTurns: 2,
		},
	};
}

function customEntry(id: string, data: unknown): SessionEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		customType: DESCRIPTOR_CUSTOM_TYPE,
		data,
	};
}

test("descriptor parser returns a detached validated value", () => {
	const input = descriptor();
	const parsed = parseDescriptor(input);
	assert.deepEqual(parsed, input);
	assert.notEqual(parsed.agent.tools, input.agent.tools);
});

test("v3 descriptors persist readable paths and context policy", () => {
	const input = currentDescriptor();
	const parsed = parseDescriptor(input);
	assert.deepEqual(parsed, input);
	assert.equal(parsed.version, 3);
	if (parsed.version !== 3 || input.version !== 3) return;
	assert.notEqual(parsed.task, input.task);
	assert.notEqual(parsed.context, input.context);
});

test("v3 descriptors reject inconsistent paths and context", () => {
	const wrongPath = currentDescriptor();
	if (wrongPath.version !== 3) return;
	wrongPath.task.path = "/root/another-name";
	assert.throws(() => parseDescriptor(wrongPath), /must end with task.name/);

	const wrongContext = currentDescriptor() as SubagentDescriptor & {
		context: { mode: "fresh"; completedTurns: number };
	};
	wrongContext.context = { mode: "fresh", completedTurns: 2 };
	assert.throws(
		() => parseDescriptor(wrongContext),
		/available only for last_n_completed/,
	);
});

test("legacy descriptors default to background-enabled behavior", () => {
	const input = descriptor() as SubagentDescriptor & {
		runtime: Omit<SubagentDescriptor["runtime"], "enableRunInBackground">;
	};
	delete (input.runtime as Partial<SubagentDescriptor["runtime"]>).enableRunInBackground;
	const parsed = parseDescriptor(input);
	assert.equal(parsed.runtime.enableRunInBackground, true);
});

test("legacy descriptors receive the default background concurrency limit", () => {
	const input = descriptor() as SubagentDescriptor & {
		runtime: Omit<
			SubagentDescriptor["runtime"],
			"maxConcurrentBackgroundRuns"
		>;
	};
	delete (
		input.runtime as Partial<SubagentDescriptor["runtime"]>
	).maxConcurrentBackgroundRuns;
	const parsed = parseDescriptor(input);
	assert.equal(parsed.runtime.maxConcurrentBackgroundRuns, 4);
});

test("legacy descriptors receive a disabled idle runtime cache", () => {
	const input = descriptor() as SubagentDescriptor & {
		runtime: Omit<SubagentDescriptor["runtime"], "maxIdleRuntimes">;
	};
	delete (
		input.runtime as Partial<SubagentDescriptor["runtime"]>
	).maxIdleRuntimes;
	assert.equal(parseDescriptor(input).runtime.maxIdleRuntimes, 0);
});

test("legacy descriptors receive the legacy background protocol", () => {
	const input = descriptor() as SubagentDescriptor & {
		runtime: Omit<SubagentDescriptor["runtime"], "backgroundProtocol">;
	};
	delete (
		input.runtime as Partial<SubagentDescriptor["runtime"]>
	).backgroundProtocol;
	const parsed = parseDescriptor(input);
	assert.equal(parsed.runtime.backgroundProtocol, "legacy");
});

test("mailbox-v2 descriptors retain their protocol snapshot", () => {
	const input = descriptor();
	input.runtime.backgroundProtocol = "mailbox-v2";
	assert.equal(parseDescriptor(input).runtime.backgroundProtocol, "mailbox-v2");
});

test("legacy syncBundledAgents snapshots are validated then discarded", () => {
	const input = descriptor() as SubagentDescriptor & {
		runtime: SubagentDescriptor["runtime"] & { syncBundledAgents: boolean };
	};
	input.runtime.syncBundledAgents = false;
	const parsed = parseDescriptor(input);
	assert.equal("syncBundledAgents" in parsed.runtime, false);
});

test("legacy bundled agent snapshots remain readable", () => {
	const input = descriptor() as SubagentDescriptor & {
		agent: SubagentDescriptor["agent"] & { source: "bundled" };
	};
	input.agent.source = "bundled";
	assert.equal(parseDescriptor(input).agent.source, "bundled");
});

test("descriptor folding is last-wins for fork seeds", () => {
	const first = descriptor("ancestor");
	const second = descriptor("child");
	const folded = foldDescriptor([customEntry("one", first), customEntry("two", second)]);
	assert.equal(folded.kind, "valid");
	if (folded.kind === "valid") assert.equal(folded.descriptor.label, "child");
});

test("malformed current descriptors fold to a diagnostic", () => {
	const malformed = { ...descriptor(), depth: -1 };
	const folded = foldDescriptor([customEntry("bad", malformed)]);
	assert.equal(folded.kind, "corrupt");
	if (folded.kind === "corrupt") assert.match(folded.message, /depth/);
});

test("descriptor agent ids must be UUIDv7", () => {
	for (const agentId of ["not-a-uuid", "01900000-0000-4000-8000-000000000000"]) {
		const folded = foldDescriptor([customEntry("bad", { ...descriptor(), agentId })]);
		assert.equal(folded.kind, "corrupt");
		if (folded.kind === "corrupt") assert.match(folded.message, /agent id/);
	}
});

test("v1 descriptors are rejected as failed legacy data", () => {
	const legacy = { ...descriptor(), version: 1 };
	delete (legacy as Partial<SubagentDescriptor>).agentId;
	delete (legacy as Partial<SubagentDescriptor>).parentAgentId;
	const folded = foldDescriptor([customEntry("legacy", legacy)]);
	assert.equal(folded.kind, "corrupt");
	if (folded.kind === "corrupt") assert.match(folded.message, /version/);
});
