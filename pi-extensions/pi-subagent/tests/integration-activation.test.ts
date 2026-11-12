import assert from "node:assert/strict";
import { test } from "node:test";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import {
	createAgentSessionFromServices, createAgentSessionServices, type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import subagentExtension from "../src/index.ts";
import type { CodexIntegration } from "../src/codex-integration.ts";
import { deferred, fixture, waitUntil } from "./support/fixture.ts";

test("activation awaits one integration load across session hooks; children and cold resumes get fresh inline instances", async t => {
	const f = await fixture(t, { codexIntegration: { status: "absent" } });
	await f.coordinator.shutdown();
	const ready = deferred<CodexIntegration>();
	let loads = 0;
	const instances: InlineExtension[] = [];
	const childSessions: string[] = [];
	const integration: CodexIntegration = {
		status: "ready",
		create: options => {
			assert.equal(options?.parentSessionManager?.getSessionId(), f.manager.getSessionId());
			const index = instances.length;
			const inline: InlineExtension = {
				name: "integration-fixture",
				factory: pi => {
					let runs = 0;
					pi.on("session_start", (_event, ctx) => { childSessions.push(ctx.sessionManager.getSessionId()); });
					pi.on("before_agent_start", event => {
						event.systemPromptOptions.sections.integration_fixture = `Instance ${index}, run ${++runs}`;
					});
				},
			};
			instances.push(inline);
			return inline;
		},
	};
	let activated = false;
	const servicesPromise = createAgentSessionServices({
		cwd: f.root, agentDir: f.agentDir, modelRuntime: f.modelRuntime,
		resourceLoaderOptions: {
			noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
			extensionFactories: [async pi => {
				await subagentExtension(pi, { agentDir: f.agentDir, loadCodexIntegration: () => {
					loads++;
					return loads === 1 ? ready.promise : Promise.resolve(integration);
				} });
				activated = true;
			}],
		},
	});
	await waitUntil(() => loads === 1);
	assert.equal(activated, false, "extension activation must await integration resolution");
	ready.resolve(integration);
	const services = await servicesPromise;
	assert.deepEqual(services.diagnostics, []);
	const { session } = await createAgentSessionFromServices({
		services, sessionManager: f.manager, model: f.model, thinkingLevel: "off",
	});
	t.after(async () => {
		await session.dispose();
		services.resourceLoader.getExtensions().runtime.invalidate();
	});
	const errors: unknown[] = [];
	await session.bindExtensions({ mode: "print", onError: error => errors.push(error) });
	const call = async (name: string, args: Record<string, unknown>) => {
		const tool = session.getToolDefinition(name);
		assert.ok(tool);
		return tool.execute(name, args, undefined, undefined, session.extensionRunner.createToolContext(name, undefined));
	};
	const idle = async () => {
		const deadline = Date.now() + 5000;
		for (;;) {
			const { agents } = (await call("list_agents", {})).details as {
				agents: Array<{ agent_name: string; agent_status: string }>;
			};
			const children = agents.filter(agent => agent.agent_name !== "/root");
			assert.ok(!children.some(agent => agent.agent_status === "errored"), JSON.stringify(children));
			if (children.length === 2 && children.every(agent => agent.agent_status === "completed")) return;
			assert.ok(Date.now() < deadline, JSON.stringify(children));
			await new Promise(done => setTimeout(done, 5));
		}
	};
	await Promise.all(["first", "second"].map(task_name => call("spawn_agent", {
		task_name, message: "work", fork_turns: "none",
	})));
	await idle();
	assert.equal(instances.length, 2);
	assert.notEqual(instances[0], instances[1]);
	assert.equal(new Set(childSessions).size, 2);
	for (const type of ["session_start", "session_tree"] as const) {
		if (type === "session_start") await session.extensionRunner.emit({ type, reason: "resume" });
		else await session.extensionRunner.emit({ type, oldLeafId: f.manager.getLeafId(), newLeafId: f.manager.getLeafId() });
		await call("followup_task", { target: "first", message: "cold resume" });
		await idle();
		assert.equal(loads, 1, `${type} must reuse the activated integration`);
	}
	assert.equal(instances.length, 4);
	assert.equal(new Set(instances).size, 4);
	assert.equal(new Set(childSessions).size, 2, "cold resume preserves child session identity");
	for (const [index, request] of f.requests.entries()) {
		assert.ok(getCurrentSystemPrompt(request.messages).includes(`Instance ${index}, run 1`),
			"each runtime must execute its own inline factory with fresh mutable state");
	}
	assert.equal(f.requests.length, 4);
	await session.reload();
	assert.equal(loads, 2, "a new extension activation performs its own single load");
	await call("followup_task", { target: "first", message: "after reload" });
	await idle();
	assert.equal(loads, 2);
	assert.equal(instances.length, 5);
	assert.equal(new Set(instances).size, 5);
	assert.deepEqual(errors, []);
});
