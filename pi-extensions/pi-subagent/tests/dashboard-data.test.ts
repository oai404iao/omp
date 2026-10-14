import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolCall, Usage } from "@earendil-works/pi-ai";
import { DEFAULT_SETTINGS } from "../src/config.ts";
import { buildDashboardAgent, unavailableDashboardAgent } from "../src/dashboard-data.ts";
import { DESCRIPTOR_CUSTOM_TYPE, MESSAGE_CUSTOM_TYPE } from "../src/store.ts";
import { TELEMETRY_CUSTOM_TYPE, type RunTelemetryEntry, type TelemetrySnapshot } from "../src/telemetry.ts";
import { DESCRIPTOR_VERSION, type AgentRecord } from "../src/types.ts";

const usage: Usage = {
	input: 10, output: 4, reasoning: 2, cacheRead: 6, cacheWrite: 2, totalTokens: 22,
	cost: { input: 0.01, output: 0.02, cacheRead: 0.01, cacheWrite: 0.01, total: 0.05 },
};
function assistant(text = "answer", timestamp = 100): AssistantMessage {
	return {
		role: "assistant", content: [{ type: "text", text }], api: "openai-responses",
		provider: "fixture", model: "fixture", usage, stopReason: "stop", timestamp,
	};
}
function record(): AgentRecord {
	return {
		descriptor: {
			version: DESCRIPTOR_VERSION, id: "child-id", path: "/root/test", parentPath: "/root", depth: 1,
			cwd: "/workspace", createdAt: "2026-10-08T00:00:00.000Z",
			agent: { name: "reviewer", description: "review", systemPrompt: "", source: "user" },
			model: { provider: "fixture", id: "fixture" }, thinkingLevel: "high", forkTurns: "all",
			settings: DEFAULT_SETTINGS, anchorId: "anchor",
		},
		sessionFile: "/unused.jsonl", status: "completed", mailbox: [],
	};
}
function manager(agent = record()) {
	const session = SessionManager.inMemory();
	session.appendCustomEntry(DESCRIPTOR_CUSTOM_TYPE, agent.descriptor);
	return session;
}
function live(overrides: Partial<TelemetrySnapshot> = {}): TelemetrySnapshot {
	return { runId: "active", activeSince: 500, toolIds: [], nestedToolIds: [], activity: [], ...overrides };
}
function run(session: SessionManager, runId: string, startedAt: number, durationMs?: number) {
	session.appendCustomEntry(TELEMETRY_CUSTOM_TYPE, { version: 1, kind: "run-start", runId, startedAt });
	if (durationMs !== undefined) session.appendCustomEntry(TELEMETRY_CUSTOM_TYPE, {
		version: 1, kind: "run-end", runId, startedAt, durationMs, status: "completed",
	});
}

test("statistics exclude inherited history using the matching descriptor identity", () => {
	const agent = record();
	const session = SessionManager.inMemory();
	session.appendCustomEntry(DESCRIPTOR_CUSTOM_TYPE, { id: "parent-id" });
	session.appendMessage(assistant("inherited"));
	session.appendCustomEntry(DESCRIPTOR_CUSTOM_TYPE, agent.descriptor);
	session.appendMessage(assistant("owned"));
	const data = buildDashboardAgent(agent, session.getEntries());
	assert.equal(data.usage.requests, 1);
	assert.equal(data.usage.totalTokens, 22);
	assert.equal(data.usage.cost, 0.05);
	assert.equal(data.activity.some(item => item.summary === "inherited"), false);
	assert.equal(data.durationPartial, true);
	assert.equal(data.durationMs, undefined);
});

test("owned accounting includes auxiliary and tool usage once, and reasoning is an output subset", () => {
	const session = manager();
	session.appendMessage({
		...assistant(), stopReason: "toolUse",
		content: [{ type: "toolCall", id: "call", name: "codemode", arguments: {} }],
	});
	const result = {
		role: "toolResult" as const, toolCallId: "call", toolName: "codemode", content: [], isError: false,
		timestamp: 110, usage,
		nestedCalls: { complete: false, calls: [{ id: "call/1", name: "read", status: "ok" as const }] },
	};
	session.appendMessage(result);
	session.appendMessage(result);
	session.appendUsage("cache_warm", "fixture", "fixture", usage);
	session.appendCompaction("summary", session.getLeafId()!, 100, undefined, undefined, usage);
	session.branchWithSummary(session.getLeafId()!, "branch summary", undefined, undefined, usage);
	session.appendMessage({ ...assistant(), stopReason: "pending" });
	const data = buildDashboardAgent(record(), session.getEntries(), live({
		toolIds: ["call", "pending"], nestedToolIds: ["call/1", "call/2"],
	}));
	assert.equal(data.usage.requests, 1);
	assert.equal(data.usage.totalTokens, 110);
	assert.equal(data.usage.output, 20);
	assert.equal(data.usage.reasoning, 10);
	assert.equal(data.usage.cost, 0.25);
	assert.equal(data.usage.tools, 2);
	assert.equal(data.usage.nestedTools, 2);
	assert.equal(data.usage.nestedToolsPartial, true);
});

test("all owned branches contribute cost, while only the current branch provides task and activity", () => {
	const session = manager();
	const fork = session.getLeafId()!;
	session.appendMessage(assistant("abandoned", 100));
	session.branch(fork);
	session.appendMessage(assistant("current", 200));
	const data = buildDashboardAgent(record(), session.getEntries(), undefined, session.getBranch());
	assert.equal(data.usage.requests, 2);
	assert.equal(data.usage.cost, 0.1);
	assert.equal(data.activity.some(item => item.summary === "abandoned"), false);
	assert.equal(data.activity.some(item => item.summary === "current"), true);
});

test("unknown boundaries and unreadable sessions do not fabricate zero statistics", () => {
	const data = buildDashboardAgent(record(), []);
	assert.equal(data.usage.available, false);
	assert.equal(data.usage.cost, null);
	assert.match(data.dataError!, /boundary/);
	assert.equal(unavailableDashboardAgent(record(), "unreadable").dataError, "unreadable");
	const empty = buildDashboardAgent(record(), manager().getEntries());
	assert.equal(empty.usage.available, true);
	assert.equal(empty.usage.cost, 0);
});

test("zero-priced token usage and mixed unknown prices are not claimed as free", () => {
	const session = manager();
	session.appendMessage(assistant());
	session.appendMessage({ ...assistant(), usage: { ...usage, cost: { ...usage.cost, total: 0 } } });
	const data = buildDashboardAgent(record(), session.getEntries());
	assert.equal(data.usage.totalTokens, 44);
	assert.equal(data.usage.cost, null);
});

test("paired runs accumulate across cold resumes without idle or crash downtime", () => {
	const session = manager();
	run(session, "one", 100, 20);
	run(session, "two", 10000, 30);
	run(session, "crashed", 20000);
	const recovered = buildDashboardAgent(record(), session.getEntries());
	assert.equal(recovered.durationMs, 50);
	assert.equal(recovered.durationPartial, true);
	assert.equal(recovered.activeSince, undefined);
	run(session, "active", 500);
	const active = buildDashboardAgent(record(), session.getEntries(), live());
	assert.equal(active.durationMs, 50);
	assert.equal(active.activeSince, 500);
	assert.equal(active.durationPartial, true);
	const fresh = manager();
	run(fresh, "active", 500);
	assert.equal(buildDashboardAgent(record(), fresh.getEntries(), live()).durationPartial, false);
});

test("topic follows actual task delivery, not queued follow-ups or inherited tasks", () => {
	const agent = record();
	agent.mailbox.push({ id: "pending", from: "/root", to: agent.descriptor.path, kind: "task", text: "Initial\nDetails", createdAt: "now" });
	const session = manager(agent);
	assert.equal(buildDashboardAgent(agent, session.getEntries()).topic, "Initial");
	session.appendCustomMessageEntry(MESSAGE_CUSTOM_TYPE, "context", false, { tasks: [{ id: "initial", text: "\nDelivered\nFull task" }] });
	agent.mailbox[0]!.text = "Queued follow-up";
	const first = buildDashboardAgent(agent, session.getEntries());
	assert.equal(first.topic, "Delivered");
	assert.equal(first.task, "\nDelivered\nFull task");
	session.appendCustomMessageEntry(MESSAGE_CUSTOM_TYPE, "context", false, { tasks: [{ id: "next", text: "Next task" }] });
	assert.equal(buildDashboardAgent(agent, session.getEntries()).topic, "Next task");
	const legacy = manager(agent);
	legacy.appendCustomMessageEntry(MESSAGE_CUSTOM_TYPE, "[Agent task: /root → /root/test]\nOld task", false, {});
	assert.equal(buildDashboardAgent(agent, legacy.getEntries()).topic, "Task unavailable");
});

test("context uses live SDK state or last persisted snapshot, preserving unknown after compaction", () => {
	const session = manager();
	const context = { tokens: 20, contextWindow: 100, percent: 20, timestamp: 100, live: false };
	session.appendCustomEntry(TELEMETRY_CUSTOM_TYPE, {
		version: 1, kind: "run-end", runId: "old", startedAt: 0, durationMs: 10, context,
	});
	assert.deepEqual(buildDashboardAgent(record(), session.getEntries()).context, context);
	session.appendCompaction("summary", session.getLeafId()!, 20);
	assert.equal(buildDashboardAgent(record(), session.getEntries()).context?.tokens, null);
	assert.equal(buildDashboardAgent(record(), session.getEntries(), live()).context, undefined);
	const unknown = { ...context, tokens: null, percent: null, live: true };
	assert.deepEqual(buildDashboardAgent(record(), session.getEntries(), live({ context: unknown })).context, unknown);
});

test("recent activity is bounded, merges semantic input/results and excludes thinking", () => {
	const session = manager();
	for (let n = 0; n < 70; n++) session.appendMessage(assistant(`response ${n}`, n));
	session.appendMessage({
		...assistant("", 80), content: [
			{ type: "thinking", thinking: "private thinking" },
			{ type: "toolCall", id: "bash", name: "bash", arguments: { command: "SECRET=private run" } },
		],
	});
	session.appendMessage({
		role: "toolResult", toolCallId: "bash", toolName: "bash", content: [{ type: "text", text: "private result" }],
		isError: false, timestamp: 90,
	});
	const data = buildDashboardAgent(record(), session.getEntries());
	assert.equal(data.activity.length, 50);
	assert.equal(data.activity.filter(item => item.id === "tool:bash").length, 1);
	assert.equal(data.activity[0]!.status, "success");
	assert.equal(data.activity[0]!.preview, "$ SECRET=private run\n› private result");
	assert.equal(JSON.stringify(data.activity).includes("private thinking"), false);
	assert.equal(data.activity.find(item => item.kind === "response")?.preview, "Requested bash");
});

test("ordinary and completion deliveries expose only safe counts alongside tasks", () => {
	const session = manager();
	session.appendCustomMessageEntry(MESSAGE_CUSTOM_TYPE, "PRIVATE MAIL BODY", false, {
		messageIds: ["task", "mail", "completion"], tasks: [{ id: "task", text: "Review" }],
	});
	const data = buildDashboardAgent(record(), session.getEntries());
	assert.equal(data.activity.filter(item => item.kind === "task").length, 1);
	assert.equal(data.activity.find(item => item.kind === "message")?.summary, "2 messages");
	assert.equal(JSON.stringify(data.activity).includes("PRIVATE"), false);
});

test("unfinished nested observations are partial, receipts dedupe live events and keep final statuses", () => {
	const session = manager();
	session.appendMessage({
		...assistant(), content: [{ type: "toolCall", id: "call", name: "codemode", arguments: {} }],
	});
	const current = live({
		toolIds: ["call"], nestedToolIds: ["call/1"],
		activity: [
			{ id: "tool:call", timestamp: 101, kind: "tool", status: "running", label: "codemode", summary: "" },
			{ id: "tool:call/1", timestamp: 101, kind: "tool", status: "running", label: "read", summary: "" },
		],
	});
	assert.equal(buildDashboardAgent(record(), session.getEntries(), current).usage.nestedToolsPartial, true);
	assert.equal(buildDashboardAgent(record(), session.getEntries()).usage.nestedToolsPartial, true);
	session.appendMessage({
		role: "toolResult", toolCallId: "call", toolName: "codemode", content: [], isError: false, timestamp: 110,
		nestedCalls: { complete: true, calls: [{ id: "call/1", name: "read", status: "ok" }] },
	});
	const data = buildDashboardAgent(record(), session.getEntries(), current);
	assert.equal(data.usage.tools, 1);
	assert.equal(data.usage.nestedTools, 1);
	assert.equal(data.usage.nestedToolsPartial, false);
	for (const id of ["tool:call", "tool:call/1"]) {
		assert.equal(data.activity.filter(item => item.id === id).length, 1);
		assert.equal(data.activity.find(item => item.id === id)?.status, "success");
	}
});

test("sidecar run pairs cover transcript ranges without charging idle or crash downtime", () => {
	const session = manager();
	const start = session.getLeafId()!;
	session.appendMessage(assistant("first"));
	const first = session.getLeafId()!;
	session.appendMessage(assistant("second"));
	const second = session.getLeafId()!;
	const records: RunTelemetryEntry[] = [
		{ version: 1, kind: "run-start", runId: "one", startedAt: 100, anchorId: start },
		{ version: 1, kind: "run-end", runId: "one", startedAt: 100, durationMs: 20, anchorId: first },
		{ version: 1, kind: "run-start", runId: "two", startedAt: 10000, anchorId: first },
		{ version: 1, kind: "run-end", runId: "two", startedAt: 10000, durationMs: 30, anchorId: second },
	];
	const data = buildDashboardAgent(record(), session.getEntries(), undefined, session.getBranch(), records);
	assert.equal(data.durationMs, 50);
	assert.equal(data.durationPartial, false);
	records.push({ version: 1, kind: "run-start", runId: "crashed", startedAt: 20000, anchorId: second });
	const recovered = buildDashboardAgent(record(), session.getEntries(), undefined, session.getBranch(), records);
	assert.equal(recovered.durationMs, 50);
	assert.equal(recovered.durationPartial, true);
	const missing = buildDashboardAgent(record(), session.getEntries(), undefined, session.getBranch(), []);
	assert.equal(missing.usage.totalTokens, 44);
	assert.equal(missing.durationMs, undefined);
	assert.equal(missing.durationPartial, true);
});

test("sidecar context stays branch-local, compaction invalidates stale snapshots, live records dedupe durable compactions", () => {
	const session = manager();
	const start = session.getLeafId()!;
	session.appendMessage(assistant());
	const snapshotLeaf = session.getLeafId()!;
	const context = { tokens: 20, contextWindow: 100, percent: 20, timestamp: 100, live: false };
	const records: RunTelemetryEntry[] = [
		{ version: 1, kind: "run-start", runId: "one", startedAt: 0, anchorId: start },
		{ version: 1, kind: "run-end", runId: "one", startedAt: 0, durationMs: 10, anchorId: snapshotLeaf, context },
	];
	assert.deepEqual(buildDashboardAgent(record(), session.getEntries(), undefined, session.getBranch(), records).context, context);
	const compact = session.appendCompaction("summary", snapshotLeaf, 20);
	const after = buildDashboardAgent(record(), session.getEntries(), undefined, session.getBranch(), records);
	assert.equal(after.context?.tokens, null);
	const active = buildDashboardAgent(record(), session.getEntries(), live({
		activity: [{ id: `compaction:${compact}`, timestamp: 100, kind: "compaction", status: "success", label: "Compaction", summary: "" }],
	}), session.getBranch(), records);
	assert.equal(active.activity.filter(item => item.kind === "compaction").length, 1);
	session.branch(start);
	assert.equal(buildDashboardAgent(record(), session.getEntries(), undefined, session.getBranch(), records).context, undefined);
});

test("cold semantic previews match inputs/results and finalized receipts override stale live content", () => {
	const session = manager();
	const calls: ToolCall[] = [
		{ type: "toolCall" as const, id: "write", name: "write", arguments: { path: "a.ts", content: "export const a = 1;\n", secret: "HIDDEN" } },
		{ type: "toolCall" as const, id: "edit", name: "edit", arguments: { path: "b.ts", edits: [{ oldText: "before", newText: "after" }] } },
		{ type: "toolCall" as const, id: "patch", name: "apply_patch", arguments: { input: "*** Begin Patch\n*** Add File: c.ts\n+export const c = 1;\n*** End Patch" } },
	];
	session.appendMessage({ ...assistant("", 10), content: calls, stopReason: "toolUse" });
	for (const call of calls) session.appendMessage({
		role: "toolResult", toolCallId: call.id, toolName: call.name, isError: false, timestamp: 20,
		content: [{ type: "text", text: "Saved" }],
	});
	const stale = live({ activity: [
		{ id: "tool:write", timestamp: 30, kind: "tool", status: "running", label: "write", summary: "stale", preview: "stale" },
		{ id: "tool:edit", timestamp: 30, kind: "tool", status: "error", label: "edit", summary: "stale", preview: "stale" },
	] });
	const data = buildDashboardAgent(record(), session.getEntries(), stale);
	assert.equal(data.usage.tools, 3);
	assert.equal(data.usage.requests, 1);
	const row = (id: string) => data.activity.find(item => item.id === `tool:${id}`)!;
	assert.equal(row("write").summary, "a.ts");
	assert.equal(row("write").preview, "export const a = 1;\n› Saved");
	assert.equal(row("edit").preview, "- before\n+ after\n› Saved");
	assert.match(row("patch").summary, /Add File: c.ts/);
	assert.equal(row("patch").preview, "+export const c = 1;\n› Saved");
	assert(data.activity.filter(item => item.kind === "tool").every(item => item.status === "success"));
	assert(!JSON.stringify(data.activity).includes("HIDDEN"));
	assert(!JSON.stringify(data.activity).includes("stale"));
});

test("pending responses with a same-ms timestamp remain visible without affecting finalized request totals", () => {
	const session = manager();
	session.appendMessage(assistant("finalized", 123));
	const current = live({ activity: [
		{ id: "response:live:1", timestamp: 123, kind: "response", status: "running", label: "Response", summary: "stream", preview: "stream" },
	] });
	const data = buildDashboardAgent(record(), session.getEntries(), current);
	assert.equal(data.activity.filter(item => item.kind === "response").length, 2);
	assert.equal(data.usage.requests, 1);
});
