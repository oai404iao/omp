import assert from "node:assert/strict";
import test from "node:test";
import core from "@oai404iao/pi-codex-core";
import bundle from "@oai404iao/pi-codex-minimal-tools";
import { getCodexBroker } from "@oai404iao/pi-codex-runtime";
import {
	compositionModel, createCompositionHost, withCompositionDirectory, writeCompositionConfig,
} from "./support/composition-host.js";

for (const [name, install] of [["core", core], ["bundle", bundle]] as const) {
	test(`${name}: removed settings preserve opaque checkpoint guards without image fallback`, t =>
		withCompositionDirectory(async directory => {
			writeCompositionConfig(directory, {
				compactionMode: "responses-compact",
				directImageApiFallback: true,
				imageGeneration: true,
			});
			let requests = 0;
			t.mock.method(globalThis, "fetch", async () => {
				requests++;
				throw new Error("Legacy settings must not initiate network fallback");
			});
			const host = createCompositionHost(directory);
			const notifications: string[] = [];
			let aborts = 0;
			let authCalls = 0;
			host.ctx.model = compositionModel("gpt-5.5", "openai-codex");
			host.ctx.ui = { notify: (message: string) => notifications.push(message) };
			host.ctx.abort = () => { aborts++; };
			host.ctx.modelRegistry.getApiKeyAndHeaders = async () => {
				authCalls++;
				throw new Error("Legacy settings must not initiate authentication");
			};
			try {
				assert.doesNotThrow(() => install(host.api()));
				assert.equal(host.providers.size, 2, "legacy settings must not unload core");
				assert.equal(host.handlers.get("context")?.length, 1);
				assert.equal(host.handlers.get("session_before_compact")?.length, 1);
				assert.equal(host.tools.has("image_generation"), false);
				assert.equal(host.commands.has("image-gen"), false);
				assert.equal(getCodexBroker(host.api()).tools.has("image_generation"), false);
				await host.emit("session_start");
				assert.equal(host.active().includes("image_generation"), false);

				const session = host.ctx.sessionManager;
				session.appendMessage({ role: "user", content: "Earlier conversation", timestamp: 1 });
				session.appendCompaction("Opaque placeholder\n[native-checkpoint:legacy]", null, 100, {
					kind: "openai-native-compaction",
					version: 4,
					checkpointId: "legacy",
					mode: "responses-compact",
					provider: host.ctx.model.provider,
					model: host.ctx.model.id,
					api: host.ctx.model.api,
					output: [{ type: "compaction", encrypted_content: "legacy-opaque-state" }],
				});
				const branch = structuredClone(session.getBranch());
				const messages = session.buildSessionContext().messages;
				assert.ok(messages.some((message: any) => message.role === "compactionSummary"));

				const contextResult = await host.handlers.get("context")![0]!({ messages }, host.ctx);
				assert.equal(aborts, 1, "the placeholder must not reach the model as ordinary text");
				assert.deepEqual(contextResult, { messages: [] });
				assert.match(notifications.at(-1)!, /Opaque checkpoint preserved/);

				const compactResult = await host.handlers.get("session_before_compact")![0]!({
					branchEntries: session.getBranch(),
					preparation: { tokensBefore: 100 },
					signal: new AbortController().signal,
				}, host.ctx);
				assert.deepEqual(compactResult, { cancel: true }, "Pi text compaction must not replace opaque history");
				assert.match(notifications.at(-1)!, /Cannot replace an opaque native checkpoint/);
				assert.deepEqual(session.getBranch(), branch, "the encrypted checkpoint must remain intact");

				const result = await host.providers.get("openai-codex").streamSimple(
					host.ctx.model, { messages: [], tools: [] }, {
						apiKey: "fixture-only",
						headers: { "chatgpt-account-id": "fixture-account" },
					},
				).result();
				assert.equal(result.stopReason, "error");
				assert.match(result.errorMessage, /responses-compact was removed/);
				assert.equal(authCalls, 0);
				assert.equal(requests, 0);
			} finally {
				await host.emit("session_shutdown");
				host.dispose();
			}
		}));
}
