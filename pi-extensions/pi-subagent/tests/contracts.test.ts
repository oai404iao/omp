import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Value } from "typebox/value";
import { DEFAULT_SETTINGS } from "../src/config.ts";
import {
	CloseParameters, CloseOutput, ListOutput, FollowupTaskParameters, InterruptParameters, ListAgentsParameters, SendMessageParameters,
	TOOL_DESCRIPTIONS, TOOL_NAMES, WaitAgentParameters, spawnAgentParameters,
} from "../src/schemas.ts";
import { resolveTaskPath, taskPath, pathMatches } from "../src/task-path.ts";
import { ExecutionLimiter, AgentOperationQueue } from "../src/scheduler.ts";
import { deferred } from "./support/fixture.ts";

test("seven-tool contract: plaintext closed schemas, required fields, defaults, no legacy aliases", () => {
	assert.deepEqual(TOOL_NAMES, ["spawn_agent", "send_message", "followup_task", "wait_agent", "interrupt_agent", "close_agent", "list_agents"]);
	const schemas = [spawnAgentParameters([]), SendMessageParameters, FollowupTaskParameters, WaitAgentParameters, InterruptParameters, CloseParameters, ListAgentsParameters];
	for (const schema of schemas) assert.equal(JSON.parse(JSON.stringify(schema)).additionalProperties, false);
	assert(Value.Check(schemas[0]!, { task_name: "review", message: "task" }));
	assert(!Value.Check(schemas[0]!, { task_name: "bad-name", message: "task" }));
	assert(!Value.Check(schemas[0]!, { task_name: "review", message: "task", agent_type: "missing" }));
	assert(!Value.Check(schemas[0]!, { task_name: "review", message: "task", fork_turns: "last_n_completed" }));
	for (const schema of [SendMessageParameters, FollowupTaskParameters]) {
		assert(Value.Check(schema, { target: "/root/worker", message: "plaintext" }));
		assert(!Value.Check(schema, { target: "/root/worker" }));
		assert(!Value.Check(schema, { target: "/root/worker", message: "  " }));
		assert(!Value.Check(schema, { subagent_id: "id", message: "text" }));
		assert(!Value.Check(schema, { target: "/root/worker", message: "text", interrupt: true }));
	}
	assert(Value.Check(WaitAgentParameters, {}));
	assert.equal(JSON.parse(JSON.stringify(WaitAgentParameters)).properties.timeout_ms.default, 120_000);
	assert(Value.Check(WaitAgentParameters, { timeout_ms: 0 }));
	assert(Value.Check(WaitAgentParameters, { timeout_ms: 300_000 }));
	assert(!Value.Check(WaitAgentParameters, { timeout_ms: 3600001 }));
	assert(!Value.Check(WaitAgentParameters, { targets: ["worker"] }));
	assert.doesNotMatch(JSON.stringify(schemas), /encrypted|fork_context|completed_turns|runtimeMode/);
	assert.equal(Object.keys(TOOL_DESCRIPTIONS).length, 7);
	assert.equal(createHash("sha256").update(JSON.stringify(TOOL_NAMES.map((name, index) => ({
		name, description: TOOL_DESCRIPTIONS[name], parameters: schemas[index],
	})))).digest("hex"), "848708d7eab348c43a6f88c52442d2c0d5356dde1393c8851ca4d91f9b268a54",
	"Approved seven-tool description/schema snapshot changed; review the complete contract before updating.");
});

test("execution profiles, lifecycle and pagination public contracts reject unsupported aliases and values", () => {
	for (const schema of [spawnAgentParameters([]), FollowupTaskParameters]) {
		const base = schema === FollowupTaskParameters ? { target: "review", message: "task" } : { task_name: "review", message: "task" };
		for (const thinking of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
			assert(Value.Check(schema, { ...base, model: "provider/model", thinking }));
		}
		assert(!Value.Check(schema, { ...base, thinking: "extra" }));
		assert(!Value.Check(schema, { ...base, reasoning_effort: "high" }));
	}
	assert(Value.Check(CloseParameters, { target: "/root/review" }));
	assert(!Value.Check(CloseParameters, { target: "review", recursive: false }));
	assert(Value.Check(ListAgentsParameters, { include_closed: true, limit: 200, cursor: "opaque" }));
	for (const limit of [0, 201, 1.5]) assert(!Value.Check(ListAgentsParameters, { limit }));
	assert(Value.Check(CloseOutput, { accepted: true, target: "/root/review", lifecycle: "closing", affected_count: 1 }));
	assert(Value.Check(ListOutput, { agents: [{
		agent_name: "/root/review", agent_status: "completed", lifecycle: "closed", model: "virtual/auto", thinking: "high",
		last_response: { model: "physical/model" },
	}], next_cursor: "opaque" }));
});
test("agent_type uses the same catalog snapshot without embedding role bodies", () => {
	const role = { name: "reviewer", description: "Review", systemPrompt: "PRIVATE_ROLE_BODY", source: "user" as const, filePath: "/agents/reviewer.md" };
	const schema = spawnAgentParameters([role]);
	assert(Value.Check(schema, { task_name: "r", message: "review", agent_type: "reviewer" }));
	assert(!Value.Check(schema, { task_name: "r", message: "review", agent_type: "missing" }));
	assert.doesNotMatch(JSON.stringify(schema), /PRIVATE_ROLE_BODY/);
});

test("public config schema and example match exact runtime defaults", () => {
	const schema = JSON.parse(readFileSync(new URL("../config.schema.json", import.meta.url), "utf8"));
	const example = JSON.parse(readFileSync(new URL("../config.example.json", import.meta.url), "utf8"));
	delete example.$schema;
	assert.deepEqual(example, DEFAULT_SETTINGS);
	assert.deepEqual(Object.keys(schema.properties).filter(key => key !== "$schema").sort(), Object.keys(DEFAULT_SETTINGS).sort());
	for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) assert.deepEqual(schema.properties[key].default, value);
});

test("canonical paths are caller-relative, strict and segment-filtered", () => {
	assert.equal(taskPath("/root/a", "child_2"), "/root/a/child_2");
	assert.equal(resolveTaskPath("/root/a", "child_2"), "/root/a/child_2");
	assert.equal(resolveTaskPath("/root/a", "/root/b"), "/root/b");
	for (const invalid of ["", "../b", "./b", "/root/", "/other/a", "/root/root", "/root/a-b", "/root/UPPER"]) {
		assert.throws(() => resolveTaskPath("/root", invalid), Error, invalid);
	}
	assert(pathMatches("/root/a/b", "/root/a"));
	assert(!pathMatches("/root/ab", "/root/a"));
});

test("execution admission fails fast and permit release is idempotent", () => {
	const limiter = new ExecutionLimiter(1);
	const release = limiter.acquire();
	assert.throws(() => limiter.acquire(), /capacity/);
	release(); release();
	assert.equal(limiter.count, 0);
	limiter.acquire()();
});

test("per-agent operations serialize after rejection and do not serialize other agents", async () => {
	const queue = new AgentOperationQueue();
	const gate = deferred();
	const order: string[] = [];
	const first = queue.run("a", async () => { await gate.promise; order.push("a1"); throw new Error("expected"); });
	const failure = assert.rejects(first, /expected/);
	const second = queue.run("a", () => order.push("a2"));
	await queue.run("b", () => order.push("b"));
	gate.resolve();
	await Promise.all([failure, second, queue.drain()]);
	assert.deepEqual(order, ["b", "a1", "a2"]);
});
