import assert from "node:assert/strict";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import test from "node:test";
import { InMemoryCredentialStore, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import {
	createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
	type AgentSession, type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { registerResponsesProviderRuntime } from "../src/extension/provider-runtime.js";
import { registerNativeCompaction } from "@oai404iao/pi-codex-core/internal/native-compaction";
import { withCodexSettings } from "../../../tests/codex/support/provider-lifecycle-test-support.js";
import { codexJwt } from "./support/openai-codex-test-support.js";

interface WireItem {
	type?: string;
	role?: string;
	reasoning?: { effort: string };
}

interface WireRequest {
	input: WireItem[];
	reasoning: { effort: string; context?: string };
	client_metadata?: Record<string, string>;
}

function updates(body: WireRequest): WireItem[] {
	return body.input.filter(item => item.type === "configuration_update");
}

function assertUpdates(body: WireRequest, efforts: string[], baseline = "low"): void {
	assert.deepEqual(updates(body), efforts.map(effort => ({ type: "configuration_update", reasoning: { effort } })));
	assert.equal(body.reasoning.effort, baseline, "the context-window baseline is not the current selection");
}

function assertReplayEfforts(body: WireRequest, expected: string[]): void {
	let effort: string | undefined;
	const replayed: Array<string | undefined> = [];
	for (const item of body.input) {
		if (item.type === "configuration_update") effort = item.reasoning?.effort;
		if (item.role === "assistant") replayed.push(effort);
	}
	assert.deepEqual(replayed, expected, "each historical response follows its recorded effort update");
}

async function withSessionHarness(id: string, run: (harness: {
	cwd: string;
	requests: WireRequest[];
	open(manager: SessionManager, thinkingLevel?: ModelThinkingLevel): Promise<{ session: AgentSession; api: ExtensionAPI }>;
	close(session: AgentSession): Promise<void>;
}) => Promise<void>, nativeCompaction = false): Promise<void> {
	await withCodexSettings({ webSocketEnabled: false, ...(nativeCompaction ? { compactionMode: "responses" } : {}) }, async cwd => {
		const originalFetch = globalThis.fetch;
		const requests: WireRequest[] = [];
		const openSessions = new Map<AgentSession, DefaultResourceLoader>();
		globalThis.fetch = async (input, init) => {
			const request = new Request(input, init);
			assert.equal(new URL(request.url).hostname, "session-effort.invalid");
			assert.equal(request.headers.get("x-openai-internal-codex-responses-lite"), id === "gpt-6.1-sol" ? "true" : null);
			const bytes = Buffer.from(await request.arrayBuffer());
			const body: WireRequest = JSON.parse((request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes) : bytes).toString());
			requests.push(body);
			const effort = updates(body).at(-1)?.reasoning?.effort ?? body.reasoning.effort;
			const headerMetadata = request.headers.get("x-codex-turn-metadata");
			const bodyMetadata = body.client_metadata?.["x-codex-turn-metadata"];
			assert(headerMetadata);
			assert(bodyMetadata);
			for (const value of [headerMetadata, bodyMetadata]) {
				const metadata: { reasoning_effort?: string } = JSON.parse(value);
				assert.equal(metadata.reasoning_effort, effort, "metadata reports the current effort, not the window baseline");
			}
			const responseId = `resp_${requests.length}`;
			const item = body.input.at(-1)?.type === "compaction_trigger" ? {
				type: "compaction", encrypted_content: "SESSION_EFFORT_CHECKPOINT",
			} : {
				type: "message", id: `msg_${requests.length}`, role: "assistant", status: "completed",
				content: [{ type: "output_text", text: `answer_${requests.length}`, annotations: [] }],
			};
			const events = [
				{ type: "response.created", response: { id: responseId } },
				{ type: "response.output_item.done", output_index: 0, item },
				{ type: "response.completed", response: { id: responseId, status: "completed", output: [item] } },
			];
			return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
				headers: { "content-type": "text/event-stream" },
			});
		};
		const close = async (session: AgentSession): Promise<void> => {
			await session.abort();
			session.dispose();
			openSessions.get(session)?.getExtensions().runtime.invalidate();
			openSessions.delete(session);
		};
		try {
			await run({
				cwd, requests, close,
				async open(manager, thinkingLevel) {
					const agentDir = join(cwd, "agent");
					const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
					let api: ExtensionAPI | undefined;
					const loader = new DefaultResourceLoader({
						cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noThemes: true,
						noPromptTemplates: true, noContextFiles: true,
						extensionFactories: [pi => {
							api = pi;
							registerResponsesProviderRuntime(pi, { getCurrentCwd: () => cwd });
							if (nativeCompaction) registerNativeCompaction(pi);
						}],
					});
					await loader.reload();
					assert.deepEqual(loader.getExtensions().errors, []);
					const runtime = await ModelRuntime.create({
						credentials: new InMemoryCredentialStore(), modelsPath: null,
						modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false,
					});
					const builtin = getBuiltinModels("openai").find(model => model.id === id);
					assert(builtin);
					const model = { ...builtin, baseUrl: "https://session-effort.invalid/v1",
						compat: { ...builtin.compat, supportsMidConvoEffort: true } };
					runtime.registerProvider("openai", {
						api: "openai-responses", apiKey: id === "gpt-6.1-sol" ? codexJwt() : "sk-session-effort-fixture",
						baseUrl: "https://session-effort.invalid/v1", models: [model],
					});
					const { session } = await createAgentSession({
						cwd, agentDir, modelRuntime: runtime, model: runtime.getModel("openai", id), settingsManager,
						resourceLoader: loader, sessionManager: manager, noTools: "all", thinkingLevel,
					});
					openSessions.set(session, loader);
					await session.bindExtensions({ mode: "print" });
					assert(api);
					return { session, api };
				},
			});
		} finally {
			for (const session of openSessions.keys()) await close(session);
			globalThis.fetch = originalFetch;
		}
	});
}

for (const id of ["gpt-6-sol", "gpt-6-astra", "gpt-6.1-sol"]) {
	test(`real SDK ${id}: same-session thinking changes append effort without rewriting the request prefix`, () =>
		withSessionHarness(id, async h => {
			const manager = SessionManager.create(h.cwd, join(h.cwd, "sessions"));
			const { session, api } = await h.open(manager, "low");
			const lastLevel = id === "gpt-6-sol" ? "off" : "low";
			const lastEffort = lastLevel === "off" ? "none" : "low";
			const levels: ModelThinkingLevel[] = ["low", "high", "high", lastLevel];
			const expectedEfforts = ["low", "high", "high", lastEffort];
			const updateEfforts = [["low"], ["low", "high"], ["low", "high"], ["low", "high", lastEffort]];
			for (const [index, level] of levels.entries()) {
				api.setThinkingLevel(level);
				assert.equal(session.thinkingLevel, level);
				await session.prompt(`QUESTION_${index + 1}`);
				const assistant = session.messages.at(-1);
				assert(assistant?.role === "assistant");
				assert.equal(assistant.stopReason, "stop", assistant.errorMessage ?? "");
				assert.equal(h.requests.length, index + 1);
				const body = h.requests[index]!;
				assertUpdates(body, updateEfforts[index]!);
				assertReplayEfforts(body, expectedEfforts.slice(0, index));
				if (index > 0) {
					const previous = h.requests[index - 1]!;
					assert.deepEqual(body.input.slice(0, previous.input.length), previous.input);
				}
				assert.equal(assistant.providerThinkingLevel, expectedEfforts[index]);
			}
			const path = manager.getSessionFile();
			assert(path);
			await h.close(session);
			const restored = SessionManager.open(path);
			assert.deepEqual(restored.getBranch().flatMap(entry => entry.type === "message" && entry.message.role === "assistant"
				? [entry.message.providerThinkingLevel] : []), expectedEfforts);
			const reopened = await h.open(restored);
			assert.equal(reopened.session.thinkingLevel, lastLevel);
			await reopened.session.prompt("AFTER_RELOAD");
			const body = h.requests.at(-1)!;
			assertUpdates(body, ["low", "high", lastEffort]);
			assertReplayEfforts(body, expectedEfforts);
			assert.deepEqual(body.input.slice(0, h.requests[3]!.input.length), h.requests[3]!.input);
		}));
}

test("real SDK branch and fork replay only active-branch efforts, excluding abandoned Off history", () =>
	withSessionHarness("gpt-6-sol", async h => {
		const manager = SessionManager.create(h.cwd, join(h.cwd, "sessions"));
		const initial = await h.open(manager, "low");
		await initial.session.prompt("SHARED_LOW_QUESTION");
		const lowEntry = manager.getBranch().reverse().find(entry => entry.type === "message" && entry.message.role === "assistant");
		assert(lowEntry);
		initial.session.setThinkingLevel("off");
		await initial.session.prompt("ABANDONED_OFF_QUESTION");
		const path = manager.getSessionFile();
		assert(path);
		await h.close(initial.session);
		const branched = SessionManager.open(path);
		branched.branch(lowEntry.id);
		assert(branched.getEntries().some(entry => entry.type === "message" && entry.message.role === "assistant"
			&& entry.message.providerThinkingLevel === "none"));
		const active = await h.open(branched);
		assert.equal(active.session.thinkingLevel, "low");
		active.api.setThinkingLevel("high");
		await active.session.prompt("ACTIVE_HIGH_QUESTION");
		const activeBody = h.requests.at(-1)!;
		assertUpdates(activeBody, ["low", "high"]);
		assertReplayEfforts(activeBody, ["low"]);
		assert.doesNotMatch(JSON.stringify(activeBody), /ABANDONED_OFF_QUESTION|answer_2/);
		const activeLeaf = branched.getLeafId();
		assert(activeLeaf);
		await h.close(active.session);
		const forkPath = branched.createBranchedSession(activeLeaf);
		assert(forkPath);
		assert.notEqual(forkPath, path);
		const fork = await h.open(SessionManager.open(forkPath));
		assert.equal(fork.session.thinkingLevel, "high");
		fork.session.setThinkingLevel("high");
		await fork.session.prompt("FORK_HIGH_QUESTION");
		const forkBody = h.requests.at(-1)!;
		assertUpdates(forkBody, ["low", "high"]);
		assertReplayEfforts(forkBody, ["low", "high"]);
		assert.doesNotMatch(JSON.stringify(forkBody), /ABANDONED_OFF_QUESTION|answer_2/);
		assert(SessionManager.open(path).getEntries().some(entry => entry.type === "message" && entry.message.role === "assistant"
			&& entry.message.providerThinkingLevel === "none"), "forking does not remove abandoned parent history");
	}));

test("real SDK native compaction resets effort only after a committed retain-none checkpoint", () =>
	withSessionHarness("gpt-6.1-sol", async h => {
		const manager = SessionManager.create(h.cwd, join(h.cwd, "sessions"));
		const { session, api } = await h.open(manager, "low");
		await session.prompt("BEFORE_COMPACTION_LOW");
		api.setThinkingLevel("high");
		await session.prompt("BEFORE_COMPACTION_HIGH");
		session.settingsManager.applyOverrides({ compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 0 } });
		const entriesBefore = structuredClone(manager.getEntries());
		const messagesBefore = structuredClone(session.messages);
		const cancel = api.on("session_before_compact", () => ({ cancel: true }));
		await assert.rejects(session.compact(), /Compaction cancelled/);
		cancel();
		assert.deepEqual(manager.getEntries(), entriesBefore);
		assert.deepEqual(session.messages, messagesBefore);
		await session.prompt("AFTER_CANCELLED_COMPACTION");
		assertUpdates(h.requests.at(-1)!, ["low", "high"]);
		assertReplayEfforts(h.requests.at(-1)!, ["low", "high"]);
		await session.compact();
		const checkpoint = manager.getBranch().reverse().find(entry => entry.type === "compaction");
		assert(checkpoint?.type === "compaction");
		assert.equal(checkpoint.firstKeptEntryId, checkpoint.id);
		assert(checkpoint.details && typeof checkpoint.details === "object" && "version" in checkpoint.details);
		assert.equal(checkpoint.details.version, 4);
		await session.prompt("AFTER_COMMITTED_COMPACTION");
		const body = h.requests.at(-1)!;
		assertUpdates(body, ["high"], "high");
		assert.match(JSON.stringify(body), /SESSION_EFFORT_CHECKPOINT/);
		assertReplayEfforts(body, []);
		assert.doesNotMatch(JSON.stringify(body), /answer_[123]/);
		const assistant = session.messages.at(-1);
		assert(assistant?.role === "assistant");
		assert.equal(assistant.providerThinkingLevel, "high");
	}, true));
