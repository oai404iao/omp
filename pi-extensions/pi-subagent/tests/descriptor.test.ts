import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	DESCRIPTOR_CUSTOM_TYPE,
	DESCRIPTOR_VERSION,
	descriptorContext,
	foldDescriptor,
	parseDescriptor,
} from "../src/descriptor.ts";
import type { SubagentDescriptor } from "../src/types.ts";

function descriptor(label = "inspect auth"): SubagentDescriptor {
	return {
		version: DESCRIPTOR_VERSION,
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
			runtimeMode: "background",
			maxConcurrentBackgroundRuns: 4,
			maxIdleRuntimes: 0,
			inheritExtensions: false,
			openAIIdentity: false,
			maxOutputBytes: 51200,
		},
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
	assert.notEqual(parsed.task, input.task);
	assert.notEqual(parsed.context, input.context);
});

test("descriptors reject inconsistent paths and context", () => {
	const wrongPath = descriptor();
	wrongPath.task.path = "/root/another-name";
	assert.throws(() => parseDescriptor(wrongPath), /must end with task.name/);

	const wrongContext = descriptor() as SubagentDescriptor & {
		context: { mode: "fresh"; completedTurns: number };
	};
	wrongContext.context = { mode: "fresh", completedTurns: 2 };
	assert.throws(
		() => parseDescriptor(wrongContext),
		/available only for last_n_completed/,
	);
});

test("descriptors require a runtime mode", () => {
	const input = descriptor() as unknown as {
		runtime: Record<string, unknown>;
	};
	delete input.runtime.runtimeMode;
	assert.throws(
		() => parseDescriptor(input),
		/runtime\.runtimeMode must be "foreground" or "background"/,
	);
});

test("descriptors reject an unknown runtime mode", () => {
	const input = descriptor() as unknown as {
		runtime: Record<string, unknown>;
	};
	input.runtime.runtimeMode = "sometimes";
	assert.throws(
		() => parseDescriptor(input),
		/runtime\.runtimeMode must be "foreground" or "background"/,
	);
});

test("descriptors reject retired runtime switches", () => {
	for (const retired of [
		"enableRunInBackground",
		"defaultBackground",
		"backgroundProtocol",
		"syncBundledAgents",
		"reportDelivery",
	]) {
		const input = descriptor() as unknown as {
			runtime: Record<string, unknown>;
		};
		input.runtime[retired] = true;
		const parsed = parseDescriptor(input);
		assert.equal(
			retired in parsed.runtime,
			false,
			`${retired} must not survive parsing`,
		);
	}
});

test("descriptors reject every other persisted version", () => {
	for (const version of [1, 2, 3, 5]) {
		const folded = foldDescriptor([
			customEntry("old", { ...descriptor(), version }),
		]);
		assert.equal(folded.kind, "corrupt");
		if (folded.kind === "corrupt") {
			assert.match(folded.message, /unsupported descriptor version/);
			assert.match(folded.message, new RegExp(`version ${DESCRIPTOR_VERSION}`));
		}
	}
});

test("descriptors reject retired agent snapshot sources", () => {
	const folded = foldDescriptor([
		customEntry("bundled", {
			...descriptor(),
			agent: { ...descriptor().agent, source: "bundled" },
		}),
	]);
	assert.equal(folded.kind, "corrupt");
	if (folded.kind === "corrupt") {
		assert.match(folded.message, /agent\.source is unsupported: bundled/);
	}
});

test("persisted context policy is copied out of the descriptor", () => {
	const parsed = parseDescriptor(descriptor());
	assert.deepEqual(descriptorContext(parsed), {
		mode: "last_n_completed",
		completedTurns: 2,
	});
	const context = descriptorContext(parsed);
	context.mode = "fresh";
	assert.equal(parsed.context.mode, "last_n_completed");
});

test("descriptor folding is last-wins for fork seeds", () => {
	const first = descriptor("ancestor");
	const second = descriptor("child");
	const folded = foldDescriptor([customEntry("one", first), customEntry("two", second)]);
	assert.equal(folded.kind, "valid");
	if (folded.kind === "valid") assert.equal(folded.descriptor.label, "child");
});

test("malformed descriptors fold to a diagnostic", () => {
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
