import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	beginCodexTurn, createCodexChildIdentity, createCodexRootIdentity,
	registerCodexThreadIdentity, resetCodexWireState, resolveCodexRequestIdentity,
} from "@oai404iao/pi-codex-runtime/internal/codex-wire-identity";
import { standaloneWebSearch } from "@oai404iao/pi-codex-web-search/internal/tools/web-search";
import { withCodexSettings } from "../../../tests/codex/support/provider-lifecycle-test-support.js";

for (const [mode, externalWebAccess] of [["cached", false], ["indexed", "indexed"], ["live", true]] as const) {
	test(`standalone ${mode} search matches the pinned upstream request fields`, async t => {
		await withCodexSettings({}, async agentDir => {
			writeFileSync(join(agentDir, "extensions/pi-codex-minimal-tools/models.json"), JSON.stringify({
				version: 1,
				models: [{
					id: "fixture/搜索", extends: "openai/gpt-5.6-sol",
					tools: { webSearch: {
						implementation: "standalone", contentTypes: ["text", "image"],
						mode, searchContextSize: "high", maxOutputTokens: 1234,
						userLocation: { type: "approximate", country: "CN", city: "北京", timezone: "Asia/Shanghai" },
						filters: { allowedDomains: ["example.test"] },
					} },
				}],
			}));
			const manager = SessionManager.inMemory();
			manager.appendMessage({ role: "user", content: "current user", timestamp: 0 });
			const root = registerCodexThreadIdentity(createCodexRootIdentity("golden-root"));
			registerCodexThreadIdentity(createCodexChildIdentity(manager.getSessionId(), root, {
				relation: "spawn", agentName: "/root/审查",
			}));
			beginCodexTurn(manager.getSessionId(), { startedAtMs: 1_700_000_000_123 });
			const identity = resolveCodexRequestIdentity(manager.getSessionId(), undefined)!;
			let url: string | undefined;
			let body: any;
			let headers: Headers | undefined;
			t.mock.method(globalThis, "fetch", async (requestUrl: string, init: RequestInit) => {
				url = String(requestUrl);
				headers = new Headers(init.headers);
				body = JSON.parse(String(init.body));
				return Response.json({ output: "fixture", results: [] });
			});
			const model = {
				provider: "fixture", api: "openai-responses", id: "搜索", baseUrl: "https://fixture.invalid/v1",
				input: ["text"], reasoning: true,
			} as any;
			try {
				await standaloneWebSearch({ search_query: [{ q: "query" }], response_length: "short" }, {
					cwd: process.cwd(), model, thinkingLevel: "high", sessionManager: manager,
					modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }) },
				});
				assert.equal(url, "https://fixture.invalid/v1/alpha/search");
				assert.deepEqual(body, {
					id: identity.sessionId,
					model: "搜索",
					input: [{
						type: "message", role: "user", content: [{ type: "input_text", text: "current user" }],
						internal_chat_message_metadata_passthrough: { turn_id: identity.turnId },
					}],
					commands: { search_query: [{ q: "query" }], response_length: "short" },
					settings: {
						allowed_callers: ["direct"], external_web_access: externalWebAccess,
						search_context_size: "high",
						user_location: { type: "approximate", country: "CN", city: "北京", timezone: "Asia/Shanghai" },
						filters: { allowed_domains: ["example.test"] },
					},
					max_output_tokens: 1234,
				});
				const wireMetadata = headers?.get("x-codex-turn-metadata")!;
				assert.match(wireMetadata, /^[\x00-\x7f]*$/);
				assert.deepEqual(JSON.parse(wireMetadata), {
					session_id: identity.sessionId, thread_id: identity.threadId, turn_id: identity.turnId,
					parent_thread_id: root.threadId, subagent_kind: "thread_spawn",
					turn_started_at_unix_ms: 1_700_000_000_123, model: "搜索", reasoning_effort: "high",
				});
				assert.equal(headers?.get("session-id"), null);
				assert.equal(headers?.get("thread-id"), null);
				assert.equal(headers?.get("originator"), "pi");
			} finally { resetCodexWireState(); }
		});
	});
}

test("commands and execution metadata are snapshotted before authentication", async t => {
	await withCodexSettings({}, async () => {
		const manager = SessionManager.inMemory();
		let release!: () => void;
		const context = {
			cwd: process.cwd(),
			model: { provider: "openai", api: "openai-responses", id: "gpt-5.6-sol",
				baseUrl: "https://fixture.invalid/v1", input: ["text"], reasoning: true } as any,
			thinkingLevel: "high" as "high" | "low",
			sessionManager: manager,
			modelRegistry: { getApiKeyAndHeaders: async () => {
				await new Promise<void>(resolve => { release = resolve; });
				return { ok: true as const, apiKey: "fixture" };
			} },
		};
		const input = { search_query: [{ q: "original query" }] };
		t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
			const body = JSON.parse(String(init.body));
			assert.deepEqual(body.commands, { search_query: [{ q: "original query" }] });
			assert.equal("input" in body, false);
			assert.equal(JSON.parse(new Headers(init.headers).get("x-codex-turn-metadata")!).reasoning_effort, "high");
			return Response.json({ output: "fixture" });
		});
		try {
			const pending = standaloneWebSearch(input, context);
			await Promise.resolve();
			input.search_query[0]!.q = "changed while authentication pending";
			context.thinkingLevel = "low";
			release();
			await pending;
		} finally { resetCodexWireState(); }
	});
});
