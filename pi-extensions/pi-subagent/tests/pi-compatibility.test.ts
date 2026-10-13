import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { getCurrentTools, type ToolCall } from "@earendil-works/pi-ai";
import {
	createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices,
	SessionManager,
	type CreateAgentSessionRuntimeFactory, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { MESSAGE_CUSTOM_TYPE } from "../src/store.ts";
import { deferred, fixture } from "./support/fixture.ts";

const call = (name: string, arguments_: ToolCall["arguments"], id: number): ToolCall[] =>
	[{ type: "toolCall", id: `compat-${id}`, name, arguments: arguments_ }];

async function rootRuntime(t: TestContext, f: Awaited<ReturnType<typeof fixture>>, hooks: ExtensionFactory) {
	const create: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd, agentDir: f.agentDir, modelRuntime: f.modelRuntime,
			resourceLoaderOptions: {
				noExtensions: true, extensionFactories: [f.coordinator.hooks("/root"), hooks],
			},
		});
		return {
			...await createAgentSessionFromServices({
				services, sessionManager, sessionStartEvent, model: f.model, thinkingLevel: "off",
			}), services, diagnostics: services.diagnostics,
		};
	};
	const runtime = await createAgentSessionRuntime(create, {
		cwd: f.root, agentDir: f.agentDir, sessionManager: f.manager,
	});
	t.after(async () => { await runtime.dispose(); });
	await runtime.session.bindExtensions({ mode: "print" });
	return runtime;
}

test("custom-triggered SDK runs deliver a pending inbox exactly once", async t => {
	const f = await fixture(t);
	const starts: Array<{ kind: string; idle: boolean }> = [];
	const runtime = await rootRuntime(t, f, pi => {
		pi.on("before_agent_start", (event, ctx) => {
			starts.push({ kind: event.messageType, idle: ctx.isIdle() });
		});
	});
	f.coordinator.send(f.caller, "/root", "mail for the custom run");
	await runtime.session.sendCustomMessage({
		customType: "compat-trigger", content: "Start without a user prompt.", display: false,
	}, { triggerTurn: true });
	assert.equal(f.coordinator.treeStore.mailbox("/root").length, 0);
	await runtime.session.sendCustomMessage({
		customType: "compat-trigger", content: "Another custom run.", display: false,
	}, { triggerTurn: true });
	assert.deepEqual(starts, [{ kind: "custom", idle: false }, { kind: "custom", idle: false }]);
	const delivered = runtime.session.sessionManager.getBranch().filter(entry =>
		entry.type === "custom_message" && entry.customType === MESSAGE_CUSTOM_TYPE);
	assert.equal(delivered.length, 1);
	assert.match(JSON.stringify(delivered[0]), /mail for the custom run/);
	assert.equal(f.requests.length, 2);
});

for (const lateHook of [false, true]) {
	test(`startup cancellation releases the child and retains its task (late hook=${lateHook})`, { timeout: 10_000 }, async t => {
		const reached = deferred();
		const resume = deferred();
		const key = `__pi_subagent_start_abort_${lateHook}`;
		const gate = { reached, resume, idle: true };
		(globalThis as any)[key] = gate;
		t.after(() => { delete (globalThis as any)[key]; });
		const f = await fixture(t, {
			settings: { inheritExtensions: true },
			extension: `export default function(pi) {
				const register = () => pi.on("before_agent_start", async (_event, ctx) => {
					const gate = globalThis["${key}"];
					gate.idle = ctx.isIdle();
					gate.reached.resolve();
					await gate.resume.promise;
				});
				${lateHook ? 'pi.on("session_start", register);' : "register();"}
			}`,
		});
		const controller = new AbortController();
		const pending = f.coordinator.spawn(f.caller, {
			task_name: "worker", message: "Do not lose this task.", fork_turns: "none",
		}, controller.signal);
		const rejected = assert.rejects(pending, /task envelope was not accepted/);
		await reached.promise;
		assert.equal(gate.idle, false);
		controller.abort(new Error("cancelled during startup"));
		resume.resolve();
		await rejected;
		await f.idle();
		assert.equal(f.requests.length, 0);
		assert.equal(f.coordinator.treeStore.record("/root/worker").status, "interrupted");
		assert.equal(f.coordinator.treeStore.mailbox("/root/worker").length, 1);
		assert.equal(f.coordinator.activeCount, 0);
		await f.coordinator.followup(f.caller, "worker", "Resume the interrupted startup.");
		await f.idle();
		assert.equal(f.coordinator.treeStore.record("/root/worker").status, "completed");
		assert.equal(f.requests.length, 1);
		assert.match(JSON.stringify(f.requests[0]), /Do not lose this task/);
		assert.match(JSON.stringify(f.requests[0]), /Resume the interrupted startup/);
		assert.equal(f.coordinator.treeStore.mailbox("/root/worker").length, 0);
	});
}

for (const grantMcp of [false, true]) {
	test(`SDK child ceilings constrain late MCP tools and cold resumes (exact grant=${grantMcp})`, async t => {
		const snapshots: Array<{ registered: string[]; callable: string[] }> = [];
		const key = `__pi_subagent_ceiling_${grantMcp}`;
		(globalThis as any)[key] = snapshots;
		t.after(() => { delete (globalThis as any)[key]; });
		const firstRunRequests = grantMcp ? 5 : 3;
		const f = await fixture(t, {
			settings: { inheritExtensions: true },
			extension: `export default function(pi) {
				const register = (name, exposure) => pi.registerTool({
					name, exposure, label: name, description: name,
					parameters: { type:"object", properties:{} },
					execute: async () => ({ content:[{type:"text",text:name}], details:{} }),
				});
				register("local_deferred", "deferred");
				register("mcp__docs__lookup", "deferred");
				register("mcp__other__lookup", "codemode");
				for (const name of ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]) {
					register(name, "codemode");
				}
				pi.registerTool({
					name:"probe",label:"Probe",description:"Inspect fixture tool registry",
					parameters:{type:"object",properties:{}},
					execute:async (_id, _args, _signal, _update, ctx) => {
						globalThis["${key}"].push({
							registered:pi.getAllTools().map(tool=>tool.name),
							callable:ctx.tools.map(tool=>tool.name),
						});
						return {content:[{type:"text",text:"inspected"}],details:{}};
					},
				});
				pi.on("before_agent_start", () => {
					register("mcp__late__lookup", "codemode");
					register("late_ordinary", "deferred");
				});
			}`,
			reply: (_context, n) => {
				const stage = n > firstRunRequests ? n - firstRunRequests : n;
				if (stage === 1) return call("probe", {}, n);
				if (stage === 2) return call("codemode", {
					code: 'text(ALL_TOOLS.map(tool => tool.name));',
				}, n);
				if (grantMcp && n === 3) return call("tool_search", { query: "mcp__docs__lookup", limit: 1 }, n);
				if (grantMcp && n === 4) return call("mcp__docs__lookup", {}, n);
				return "done";
			},
		});
		const roleTools = ["probe", "codemode", "tool_search", "local_deferred",
			...(grantMcp ? ["mcp__docs__lookup", "read_mcp_resource"] : [])];
		writeFileSync(join(f.agentDir, "agents", "ceiling.md"),
			`---\nname: ceiling\ndescription: Exact registry test\ntools: ${roleTools.join(", ")}\n---\nInspect only granted tools.\n`);
		await f.coordinator.spawn(f.caller, {
			task_name: "worker", agent_type: "ceiling", message: "Inspect.", fork_turns: "none",
		});
		await f.idle();
		assert.equal(f.requests.length, firstRunRequests);
		const declared = (request: number) => getCurrentTools(f.requests[request]!.messages).map(tool => tool.name);
		assert(!declared(0).includes("local_deferred"));
		assert(!declared(0).includes("mcp__docs__lookup"));
		if (grantMcp) assert(declared(3).includes("mcp__docs__lookup"));
		const sessionFile = f.coordinator.treeStore.record("/root/worker").sessionFile;
		const stored = SessionManager.open(sessionFile);
		// A formerly wider SDK registry may have persisted a tool declaration.
		// Restoring that transcript must still obey the current exact role.
		stored.appendMessage({
			role: "system", content: "", timestamp: Date.now(),
			toolsAdded: [{
				name: "mcp__late__lookup", description: "Previously discovered but not granted",
				parameters: { type: "object", properties: {} },
			}],
		});
		await f.restart();
		await f.coordinator.followup(f.caller, "worker", "Inspect after a cold resume.");
		await f.idle();
		assert.equal(f.requests.length, firstRunRequests + 3);
		if (grantMcp) assert(declared(firstRunRequests).includes("mcp__docs__lookup"));
		assert(!declared(firstRunRequests).includes("mcp__late__lookup"));
		assert.equal(snapshots.length, 2);
		for (const snapshot of snapshots) {
			for (const denied of ["mcp__late__lookup", "mcp__other__lookup", "late_ordinary",
				"list_mcp_resources", "list_mcp_resource_templates"]) {
				assert(!snapshot.registered.includes(denied), `registered ${denied}`);
				assert(!snapshot.callable.includes(denied), `callable ${denied}`);
			}
			for (const name of ["mcp__docs__lookup", "read_mcp_resource"]) {
				assert.equal(snapshot.registered.includes(name), grantMcp, name);
				assert.equal(snapshot.callable.includes(name), grantMcp, name);
			}
			assert(snapshot.callable.includes("local_deferred"));
			assert(snapshot.registered.includes("send_message"));
			assert(!snapshot.callable.includes("send_message"));
		}
		const scriptResults = f.requests.flatMap(context => context.messages.filter(message =>
			message.role === "toolResult" && message.toolName === "codemode"));
		assert(scriptResults.length > 0);
		for (const result of scriptResults) {
			assert.equal(result.role, "toolResult");
			if (result.role !== "toolResult") continue;
			assert.equal(result.isError, false, JSON.stringify(result));
			assert.doesNotMatch(JSON.stringify(result.content), /mcp__late__lookup|mcp__other__lookup|late_ordinary/);
		}
	});
}
