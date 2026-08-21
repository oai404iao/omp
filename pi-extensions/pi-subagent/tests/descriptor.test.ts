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
			source: "bundled",
		},
		model: { provider: "openai", id: "gpt-5" },
		thinkingLevel: "low",
		runtime: {
			agentScope: "user",
			syncBundledAgents: false,
			maxDepth: 3,
			enableRunInBackground: true,
			defaultBackground: true,
			reportDelivery: "wakeup",
			inheritExtensions: false,
			openAIIdentity: false,
			maxOutputBytes: 51200,
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

test("legacy descriptors default to background-enabled behavior", () => {
	const input = descriptor() as SubagentDescriptor & {
		runtime: Omit<SubagentDescriptor["runtime"], "enableRunInBackground">;
	};
	delete (input.runtime as Partial<SubagentDescriptor["runtime"]>).enableRunInBackground;
	const parsed = parseDescriptor(input);
	assert.equal(parsed.runtime.enableRunInBackground, true);
});

test("legacy descriptors preserve synchronized bundled-agent behavior", () => {
	const input = descriptor() as SubagentDescriptor & {
		runtime: Omit<SubagentDescriptor["runtime"], "syncBundledAgents">;
	};
	delete (input.runtime as Partial<SubagentDescriptor["runtime"]>).syncBundledAgents;
	const parsed = parseDescriptor(input);
	assert.equal(parsed.runtime.syncBundledAgents, true);
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
