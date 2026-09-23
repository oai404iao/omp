import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createAgentSession, DefaultResourceLoader, ExtensionRunner, ModelRuntime, SessionManager, SettingsManager, type ExtensionFactory, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { getCurrentSystemPrompt, getCurrentTools, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { applyNativeCompactionContext, registerNativeCompaction, NATIVE_COMPACTION_DETAILS_KIND } from "../src/native-compaction.js";
import { responsesModel as model, withCodexSettings } from "./support/provider-lifecycle-test-support.js";

const tool = (name: string, description: string) => ({ name, description, parameters: { type: "object" } });

test("real session migrates legacy checkpoints with retain-none and preserves them on failed or stale recompression", () =>
	withCodexSettings({ compactionMode: "responses", openaiTransport: "sse" }, async (cwd) => {
		const manager = SessionManager.inMemory(cwd);
		const old = manager.appendMessage({ role: "user", content: "old history", timestamp: 1 });
		manager.appendCompaction("legacy placeholder", old, 100, {
			kind: NATIVE_COMPACTION_DETAILS_KIND, version: 3, mode: "responses",
			provider: model.provider, model: model.id, api: model.api,
			output: [{ type: "compaction", encrypted_content: "OLD_OPAQUE" }],
		}, true);
		manager.appendMessage({ role: "user", content: "tail ".repeat(1000), timestamp: 2 });
		const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
		runtime.registerProvider("openai", { apiKey: "fixture", baseUrl: model.baseUrl, api: model.api, models: [model] });
		const settingsManager = SettingsManager.inMemory({ compaction: { keepRecentTokens: 10 }, retry: { enabled: false } });
		const loader = new DefaultResourceLoader({
			cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noThemes: true,
			noPromptTemplates: true, noContextFiles: true, extensionFactories: [(pi) => registerNativeCompaction(pi)],
		});
		await loader.reload();
		const { session } = await createAgentSession({
			cwd, agentDir: cwd, model: runtime.getModel("openai", model.id)!, modelRuntime: runtime,
			sessionManager: manager, settingsManager, resourceLoader: loader,
		});
		await session.bindExtensions({ mode: "print" });
		const previousFetch = globalThis.fetch;
		let fail = false, changeLeaf = false;
		const requests: any[] = [];
		globalThis.fetch = async (_url, init) => {
			requests.push(JSON.parse(String(init?.body)));
			if (changeLeaf) manager.appendContextEdit(old, null);
			if (fail) throw new Error("fixture failure");
			const event = { type: "response.completed", response: {
				id: "compact", status: "completed", output: [{ type: "compaction", encrypted_content: "NEW_OPAQUE" }],
			} };
			return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } });
		};
		try {
			const result = await session.compact();
			assert.equal(result.firstKeptEntryId, null);
			const checkpoint = manager.getLeafEntry();
			assert(checkpoint?.type === "compaction");
			assert.equal(checkpoint.firstKeptEntryId, checkpoint.id);
			assert.equal((checkpoint.details as any).version, 4);
			assert.match(JSON.stringify(requests[0]), /OLD_OPAQUE/);
			assert.match(JSON.stringify(requests[0]), /tail/);
			assert(!manager.buildSessionContext().messages.some((message) => message.role === "user"));
			const replay = applyNativeCompactionContext(manager.buildSessionContext().messages, manager.getBranch(), session.model);
			assert.match(JSON.stringify(replay), /NEW_OPAQUE/);
			assert.throws(() => applyNativeCompactionContext(manager.buildSessionContext().messages, manager.getBranch(),
				{ ...model, id: "different-model" }), /original model/);
			for (let turn = 0; turn < 3; turn++) {
				manager.appendMessage({ role: "user", content: `recompact ${turn} `.repeat(1000), timestamp: 0 });
			}
			const config = join(cwd, "extensions/pi-codex-minimal-tools/config.json");
			for (const disabled of [{ compactionMode: "pi" }, { enabled: false }]) {
				writeFileSync(config, JSON.stringify({ compactionMode: "responses", openaiTransport: "sse", ...disabled }));
				const requestsBefore = requests.length, leafBefore = manager.getLeafId();
				await assert.rejects(session.compact(), /cancelled/i);
				assert.equal(requests.length, requestsBefore, "must not summarize an opaque placeholder using Pi");
				assert.equal(manager.getLeafId(), leafBefore);
			}
			writeFileSync(config, JSON.stringify({ compactionMode: "responses", openaiTransport: "sse" }));
			for (const changed of [false, true]) {
				for (let turn = 0; turn < 3; turn++) {
					manager.appendMessage({ role: "user", content: `next ${turn} `.repeat(1000), timestamp: 0 });
				}
				const count = manager.getEntries().filter((entry) => entry.type === "compaction").length;
				fail = true; changeLeaf = changed;
				await assert.rejects(session.compact(), /cancelled/i);
				assert.equal(manager.getEntries().filter((entry) => entry.type === "compaction").length, count);
			}
		} finally {
			globalThis.fetch = previousFetch;
			session.dispose();
		}
	}));

test("failed initial compaction cancels instead of summarizing a stale edited snapshot", () =>
	withCodexSettings({ compactionMode: "responses" }, async (cwd) => {
		const manager = SessionManager.inMemory(cwd);
		const id = manager.appendMessage({ role: "user", content: "private", timestamp: 1 });
		let handler: any;
		registerNativeCompaction({ on: (name: string, fn: any) => { if (name === "session_before_compact") handler = fn; } } as any);
		const result = await handler({
			branchEntries: manager.getBranch(), signal: new AbortController().signal,
		}, {
			cwd, model, sessionManager: manager,
			modelRegistry: { getApiKeyAndHeaders: async () => {
				manager.appendContextEdit(id, null);
				throw new Error("auth failure after context edit");
			} },
		});
		assert.deepEqual(result, { cancel: true });
	}));

for (const version of [3, 4]) {
	for (const transform of ["none", "before", "after", "remove-checkpoint"] as const) {
		test(`real runner: native v${version} composes with ${transform} transform`, () =>
			withCodexSettings({ compactionMode: "responses" }, async (cwd) => {
				const manager = SessionManager.inMemory(cwd);
				manager.appendMessage({
					role: "system", content: "BASE", sections: { rules: "OLD", removed: "OBSOLETE" },
					toolsAdded: [tool("retired", "old"), tool("same", "old")], timestamp: 1,
				});
				const old = manager.appendMessage({ role: "user", content: "COMPACTED", timestamp: 2 });
				const compact = manager.appendCompaction("placeholder [native-checkpoint:fixture]",
					version === 4 ? null : old, 100, {
						kind: NATIVE_COMPACTION_DETAILS_KIND, version, checkpointId: "fixture",
						mode: "responses", provider: model.provider, model: model.id, api: model.api,
						output: [{ type: "compaction", encrypted_content: "OPAQUE" }],
					}, true);
				manager.appendMessage({ role: "user", content: "SECRET", timestamp: 0 });
				const edited = manager.appendMessage({ role: "user", content: "ORIGINAL", timestamp: 0 });
				manager.appendContextEdit(edited, { content: "CANONICAL" });
				manager.appendMessage({
					role: "system", content: "", sections: { rules: "CURRENT", removed: null },
					toolsRemoved: [{ name: "retired" }, { name: "same" }], toolsAdded: [tool("same", "current")], timestamp: 3,
				});
				assert.equal((manager.getEntry(compact) as any).firstKeptEntryId, version === 4 ? compact : old);
				const filter: ExtensionFactory = (pi) => { pi.on("context", (event) => ({
					messages: transform === "remove-checkpoint"
						? event.messages.filter((m) => m.role !== "compactionSummary")
						: [...structuredClone(event.messages).filter((m) => m.role !== "user" || m.content !== "SECRET").map((m) =>
							m.role === "user" && m.content === "CANONICAL" ? { ...m, content: "FILTERED" } : m),
						{ role: "user", content: "INJECTED", timestamp: 0 }],
				})); };
				const factories: ExtensionFactory[] = [];
				if (transform === "before" || transform === "remove-checkpoint") factories.push(filter);
				factories.push((pi) => registerNativeCompaction(pi));
				if (transform === "after") factories.push(filter);
				const loader = new DefaultResourceLoader({
					cwd, agentDir: cwd, noExtensions: true, noSkills: true, noThemes: true,
					noContextFiles: true, noPromptTemplates: true, extensionFactories: factories,
				});
				await loader.reload();
				const loaded = loader.getExtensions();
				assert.deepEqual(loaded.errors, []);
				const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, manager, {} as ModelRegistry);
				const errors: string[] = [], warnings: string[] = [];
				let aborted = false;
				runner.onError((error) => errors.push(error.error));
				runner.setUIContext({ ...runner.getUIContext(), notify: (message) => warnings.push(message) }, "print");
				runner.bindCore({ getActiveTools: () => [], getAllTools: () => [], getThinkingLevel: () => "off" } as any, {
					getModel: () => model, isIdle: () => false, getSignal: () => undefined,
					abort: () => { aborted = true; },
				} as any);
				const input = manager.buildSessionContext().messages;
				const raw = structuredClone(manager.getBranch());
				try {
					const output = await runner.emitContext(input);
					assert.deepEqual(errors, []);
					assert.deepEqual(manager.getBranch(), raw);
					const refused = version === 3 && (transform === "before" || transform === "remove-checkpoint");
					assert.equal(aborted, refused);
					if (refused) {
						assert.match(warnings.join("\n"), /Legacy native checkpoint.*\/compact/);
						assert.doesNotMatch(JSON.stringify(output), /SECRET|ORIGINAL|OPAQUE/);
						return;
					}
					assert.deepEqual(warnings, []);
					assert.match(getCurrentSystemPrompt(output), /CURRENT/);
					assert.doesNotMatch(getCurrentSystemPrompt(output), /OLD|OBSOLETE/);
					assert.deepEqual(getCurrentTools(output).map((t) => [t.name, t.description]), [["same", "current"]]);
					const text = JSON.stringify(output);
					assert.doesNotMatch(text, /COMPACTED|ORIGINAL/);
					assert.equal(text.includes("OPAQUE"), transform !== "remove-checkpoint");
					if (transform === "before" || transform === "after") {
						assert.doesNotMatch(text, /SECRET|CANONICAL/);
						assert.match(text, /FILTERED/);
						assert.match(text, /INJECTED/);
					} else assert.match(text, /CANONICAL/);
				} finally { loaded.runtime.invalidate(); }
			}));
	}
}
