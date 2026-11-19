import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { getCurrentSystemPrompt, type Context, type ToolCall } from "@earendil-works/pi-ai";
import {
	createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices,
	SessionManager, type CustomMessageEntry,
} from "@earendil-works/pi-coding-agent";
import subagentExtension from "../src/index.ts";
import { MESSAGE_CUSTOM_TYPE, TreeStore } from "../src/store.ts";
import { deferred, fixture, waitUntil, type Reply } from "./support/fixture.ts";

const rootSection = "Root mail integration test session.";
const workerOutput = "Worker final result.";
const spawnWorker: ToolCall[] = [{ type: "toolCall", id: "spawn-worker", name: "spawn_agent",
	arguments: { task_name: "worker", message: "do work", fork_turns: "none" } }];

async function rootFixture(t: TestContext, rootReplies: Array<Reply | Promise<Reply>>, childReplies: Array<Reply | Promise<Reply>>) {
	const rootRequests: Context[] = [];
	const childRequests: Context[] = [];
	const f = await fixture(t, {
		codexIntegration: { status: "absent" },
		reply: context => getCurrentSystemPrompt(context.messages).includes(rootSection)
			? rootReplies[rootRequests.push(context) - 1] ?? "Unexpected root request"
			: childReplies[childRequests.push(context) - 1] ?? "Unexpected child request",
	});
	const treeId = f.coordinator.treeStore.snapshot.id;
	const readStore = () => new TreeStore(f.manager.getSessionDir(), treeId, f.manager.getSessionId());
	return { ...f, rootRequests, childRequests, readStore, async open(onSettled?: (count: number) => void | Promise<void>) {
		await f.coordinator.shutdown(); // The real extension takes over the existing persisted tree.
		const starts: Array<"user" | "custom"> = [];
		const settled: boolean[] = [];
		const errors: unknown[] = [];
		const runtime = await createAgentSessionRuntime(async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd, agentDir: f.agentDir, modelRuntime: f.modelRuntime,
				resourceLoaderOptions: { noExtensions: true, extensionFactories: [
					pi => subagentExtension(pi, { agentDir: f.agentDir, loadCodexIntegration: async () => f.codexIntegration }),
					pi => {
						pi.on("before_agent_start", event => {
							starts.push(event.messageType);
							event.systemPromptOptions.sections.root_mail_fixture = rootSection;
						});
						pi.on("agent_settled", event => {
							settled.push(event.aborted);
							return onSettled?.(settled.length);
						});
					},
				] },
			});
			return { ...await createAgentSessionFromServices({
				services, sessionManager, sessionStartEvent, model: f.model, thinkingLevel: "off",
			}), services, diagnostics: services.diagnostics };
		}, { cwd: f.root, agentDir: f.agentDir, sessionManager: f.manager });
		t.after(() => runtime.dispose());
		const { session } = runtime;
		await session.bindExtensions({ mode: "print", onError: error => errors.push(error) });
		return { session, starts, settled, errors };
	} };
}

function assertDelivered(f: Awaited<ReturnType<typeof rootFixture>>, bodies: string[], userPrompts = 1) {
	const branch = SessionManager.open(f.manager.getSessionFile()!).getBranch();
	const receipts = branch.filter((entry): entry is CustomMessageEntry =>
		entry.type === "custom_message" && entry.customType === MESSAGE_CUSTOM_TYPE);
	const messageIds = receipts.flatMap(entry => (entry.details as { messageIds: string[] }).messageIds);
	assert.equal(messageIds.length, bodies.length);
	assert.equal(new Set(messageIds).size, bodies.length, "each message has one durable receipt");
	assert.equal(branch.filter(entry => entry.type === "message" && entry.message.role === "user").length, 1 + userPrompts,
		"the mailbox does not add user messages");
	assert.deepEqual(f.readStore().mailbox("/root"), [], "settlement acknowledges the durable receipts");
	const request = JSON.stringify(f.rootRequests.at(-1)?.messages);
	for (const body of bodies) {
		assert.equal(receipts.filter(entry => String(entry.content).includes(body)).length, 1);
		assert.equal(request.split(body).length - 1, 1, "the model sees each body once in context");
	}
}

for (const stopReason of ["stop", "error", "aborted"] as const) {
	test(`child completion starts a custom root turn after root ends with ${stopReason}`, async t => {
		const finishRoot = deferred<Reply>();
		const finishChild = deferred<string>();
		const f = await rootFixture(t, [spawnWorker, finishRoot.promise, "Integrated completion."], [finishChild.promise]);
		const { session, starts, settled, errors } = await f.open();
		const prompt = session.prompt("Delegate, then end without waiting.");
		await waitUntil(() => f.rootRequests.length === 2 && f.childRequests.length === 1);
		if (stopReason === "aborted") await session.abort();
		else finishRoot.resolve(stopReason === "error" ? { error: "Scripted root failure" } : "Root stops.");
		await prompt;
		assert.equal(session.isIdle, true);
		assert.deepEqual(settled, [stopReason === "aborted"]);
		const last = session.messages.at(-1);
		assert.equal(last?.role === "assistant" && last.stopReason, stopReason);
		assert.equal(f.readStore().record("/root/worker").status, "running");

		finishChild.resolve(workerOutput);
		await waitUntil(() => settled.length === 2);
		assert.deepEqual(starts, ["user", "custom"]);
		assert.equal(f.rootRequests.length, 3);
		assert.equal(session.getLastAssistantText(), "Integrated completion.");
		assert.deepEqual(errors, []);
		assertDelivered(f, [workerOutput]);
	});
}

test("child send_message calls coalesce into a custom root turn while the child remains running", async t => {
	const sendUpdates = deferred<ToolCall[]>();
	const finishChild = deferred<string>();
	const bodies = ["First progress update.", "Second progress update."];
	const f = await rootFixture(t, [spawnWorker, "Root stops.", "Read both updates.", "Integrated completion."],
		[sendUpdates.promise, finishChild.promise]);
	const { session, starts, settled, errors } = await f.open();
	const prompt = session.prompt("Delegate and handle updates later.");
	await waitUntil(() => f.rootRequests.length === 2 && f.childRequests.length === 1);
	await prompt;
	assert.deepEqual(starts, ["user"]);
	assert.equal(session.isIdle, true);
	sendUpdates.resolve(bodies.map((message, index) => ({ type: "toolCall", id: `send-${index}`,
		name: "send_message", arguments: { target: "/root", message } })));
	await waitUntil(() => settled.length === 2 && f.childRequests.length === 2);
	assert.equal(f.readStore().record("/root/worker").status, "running", "no completion has been generated");
	assert.deepEqual(starts, ["user", "custom"]);
	assert.equal(f.rootRequests.length, 3);
	assert.deepEqual(errors, []);
	assertDelivered(f, bodies);

	finishChild.resolve(workerOutput);
	await waitUntil(() => settled.length === 3);
	assert.deepEqual(starts, ["user", "custom", "custom"]);
	assert.equal(f.rootRequests.length, 4);
	assert.deepEqual(errors, []);
	assertDelivered(f, [...bodies, workerOutput]);
});

test("completion during an active root response follows the existing safe boundary", async t => {
	const finishRoot = deferred<string>();
	const finishChild = deferred<string>();
	const f = await rootFixture(t, [spawnWorker, finishRoot.promise, "Integrated completion."], [finishChild.promise]);
	const { session, starts, settled, errors } = await f.open();
	const prompt = session.prompt("Delegate and keep working.");
	await waitUntil(() => f.rootRequests.length === 2 && f.childRequests.length === 1);
	finishChild.resolve(workerOutput);
	await waitUntil(() => f.readStore().mailbox("/root").length === 1);
	await setImmediate();
	assert.deepEqual(settled, []);
	assert.deepEqual(starts, ["user"]);
	assert.equal(f.rootRequests.length, 2, "the unfinished response must not be overlapped by a wake");
	finishRoot.resolve("Reached the boundary.");
	await prompt;
	assert.deepEqual(starts, ["user"], "mail continued the current run instead of starting another");
	assert.deepEqual(settled, [false]);
	assert.equal(f.rootRequests.length, 3);
	assert.deepEqual(errors, []);
	assertDelivered(f, [workerOutput]);
});

test("a prompt deferred during settlement reads new mail without a redundant model request", async t => {
	const finishChild = deferred<string>();
	const finishSettlement = deferred();
	const f = await rootFixture(t, [spawnWorker, "Root stops.", "Follow-up answered."], [finishChild.promise]);
	const { session, starts, settled, errors } = await f.open(count => {
		if (count === 1) return finishSettlement.promise;
	});
	const firstPrompt = session.prompt("Delegate before the next prompt.");
	try {
		await waitUntil(() => settled.length === 1 && f.childRequests.length === 1);
		await session.prompt("Read any updates and continue.");
		finishChild.resolve(workerOutput);
		await waitUntil(() => f.readStore().mailbox("/root").length === 1);
		await setImmediate();
		assert.deepEqual(starts, ["user"], "the follow-up prompt and mail wake are deferred while settlement is held");
	} finally {
		finishSettlement.resolve();
		await firstPrompt;
	}
	assert.equal(f.rootRequests.length, 3, "the wake must not run the model after the follow-up already consumed the mail");
	assert.match(JSON.stringify(f.rootRequests.at(-1)?.messages), /Read any updates and continue\./);
	assert.deepEqual(errors, []);
	assertDelivered(f, [workerOutput], 2);
});

test("attaching with old unread mail waits for user input", async t => {
	const f = await rootFixture(t, ["Integrated old completion."], [workerOutput]);
	await f.coordinator.spawn(f.caller, { task_name: "worker", message: "Finish before the root attaches", fork_turns: "none" });
	await f.idle();
	assert.equal(f.readStore().mailbox("/root").length, 1);
	const { session, starts, settled, errors } = await f.open();
	await setImmediate();
	assert.deepEqual(starts, []);
	assert.equal(f.rootRequests.length, 0);
	assert.equal(f.readStore().mailbox("/root").length, 1);
	await session.prompt("Read pending mail.");
	assert.deepEqual(starts, ["user"]);
	assert.deepEqual(settled, [false]);
	assert.equal(f.rootRequests.length, 1);
	assert.deepEqual(errors, []);
	assertDelivered(f, [workerOutput]);
});
