import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { normalizeContext, type AssistantMessageEventStream, type Context } from "@earendil-works/pi-ai";
import { stream as nativeResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { stream as nativeCodex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { createCodexStream } from "@oai404iao/pi-codex-core/internal/providers/openai-codex/stream";
import { proxyDispatcherForUrl } from "@oai404iao/pi-codex-core/internal/providers/openai-codex/proxy";
import { resetCodexWireState } from "@oai404iao/pi-codex-runtime/internal/codex-wire-identity";
import { loadModelSettings } from "@oai404iao/pi-codex-runtime/internal/model-catalog/runtime";

assert.equal(process.argv[2], "--execute", "Real requests require: --execute provider/model");
const selected = process.argv[3];
assert.ok(selected?.includes("/") && process.argv.length === 4, "Specify exactly one provider/model");
const slash = selected.indexOf("/");
const provider = selected.slice(0, slash);
const modelId = selected.slice(slash + 1);
const runtime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
const model = runtime.getModel(provider, modelId);
assert.ok(model, "Selected model is not configured; refusing account/model substitution");
assert.ok(model.api === "openai-responses" || model.api === "openai-codex-responses", "Unsupported comparison API");
const settings = loadModelSettings(model, process.cwd());
assert.ok(settings.providerShimActive && settings.modelProfile?.effective.enabled, "Selected model has no enabled extension profile");
const auth = await runtime.getAuth(model, { signal: AbortSignal.timeout(30_000) });
assert.ok(auth, "Selected model authentication is unavailable");

const root = join(homedir(), ".local/state/agents/tmp");
mkdirSync(root, { recursive: true, mode: 0o700 });
const dir = mkdtempSync(join(root, "codex-live-"));
chmodSync(dir, 0o700);
const tasks = [
	{ name: "arithmetic", prompt: "Return only the decimal integer 17 * 23. No explanation.", expected: "391" },
	{ name: "extraction", prompt: 'For [9,2,6], return only JSON with count, min, max, sum. No Markdown.', expected: { count: 3, min: 2, max: 9, sum: 17 } },
	{ name: "tool", prompt: "Call record_number exactly once with value 7. Do not answer with text.", expected: 7 },
];
const rows: Record<string, any>[] = [];
let requests = 0;
const requestLimit = 12;
const originalFetch = globalThis.fetch;
console.log(`Live evidence: ${dir}; model=${selected}; max requests=${requestLimit}; 60s per trial`);

for (let round = 0; round < 2; round++) {
	for (const task of tasks) {
		for (const implementation of round === 0 ? ["native", "extension"] : ["extension", "native"]) {
			const abort = new AbortController();
			const deadline = setTimeout(() => abort.abort(), 60_000);
			const dispatchers = new Set<Awaited<ReturnType<typeof proxyDispatcherForUrl>>>();
			const started = performance.now();
			const row: Record<string, any> = { round, task: task.name, implementation, requests: 0 };
			const context: Context = {
				systemPrompt: "Follow the requested format exactly. This is a synthetic transport smoke test.",
				messages: [{ role: "user", content: task.prompt, timestamp: 1 }],
				tools: task.name === "tool" ? [{
					name: "record_number", description: "Record the supplied integer in this synthetic test.",
					parameters: { type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false } as any,
				}] : [],
			};
			try {
				const options: any = {
					...auth.auth, env: auth.env, transport: "sse", maxRetries: 0,
					cacheRetention: "none", signal: abort.signal, reasoning: "low", reasoningEffort: "low",
					sessionId: `live-${round}-${task.name}-${implementation}`,
					onPayload(body: any) {
						body.reasoning = { ...body.reasoning, effort: "low" };
						delete body.reasoning.summary;
						delete body.service_tier;
						body.parallel_tool_calls = false;
						body.text = { ...body.text, verbosity: "low" };
						row.protocol = body.input?.some((item: any) => item.type === "additional_tools") ? "lite" : "standard";
						return body;
					},
					onResponse(metadata: { status: number }) { row.httpStatus = metadata.status; },
					fetch: async (url: any, init: any) => {
						if (requests >= requestLimit) throw new Error("Request budget exhausted");
						requests++;
						row.requests++;
						const dispatcher = await proxyDispatcherForUrl(String(url), auth.env);
						if (dispatcher) dispatchers.add(dispatcher);
						const response = await originalFetch(url, { ...init, ...(dispatcher ? { dispatcher } : {}) } as RequestInit);
						row.httpStatus = response.status;
						return response;
					},
				};
				const stream: AssistantMessageEventStream = implementation === "extension"
					? createCodexStream(model, context as any, options, { getCurrentCwd: () => process.cwd() })
					: model.api === "openai-responses"
						? nativeResponses(model as any, normalizeContext(context), options)
						: nativeCodex(model as any, normalizeContext(context), options);
				for await (const event of stream) {
					row.firstEventMs ??= performance.now() - started;
					if (event.type === "text_delta") row.firstTextMs ??= performance.now() - started;
					if (event.type === "toolcall_start") row.firstToolMs ??= performance.now() - started;
				}
				const message = await stream.result();
				const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("").trim();
				const calls = message.content.filter((block) => block.type === "toolCall");
				let matches = false;
				if (task.name === "tool") matches = calls.length === 1 && calls[0]?.name === "record_number" && calls[0]?.arguments.value === 7;
				else if (task.name === "arithmetic") matches = text === task.expected;
				else {
					try { assert.deepEqual(JSON.parse(text), task.expected); matches = true; } catch {}
				}
				row.stopReason = message.stopReason;
				if (message.errorMessage) {
					row.errorHints = [
						"lite", "additional_tools", "reasoning.context", "reasoning.effort", "prompt_cache_options",
						"max_output_tokens", "instructions", "system", "developer", "unsupported", "invalid", "authorization",
					].filter((hint) => message.errorMessage!.toLowerCase().includes(hint));
				}
				row.success = matches && ["stop", "toolUse"].includes(message.stopReason);
				row.outputCharacters = text.length;
				row.usage = message.usage;
			} catch {
				// Errors may contain private endpoints/headers; retain only bounded metadata.
				row.success = false;
				row.stopReason = abort.signal.aborted ? "aborted" : "error";
			} finally {
				row.elapsedMs = performance.now() - started;
				clearTimeout(deadline);
				for (const dispatcher of dispatchers) await dispatcher?.close();
				resetCodexWireState();
			}
			rows.push(row);
			writeFileSync(join(dir, "results.json"), JSON.stringify({
				model: selected, nativeApi: model.api, requestLimit, requests, rows,
				limits: "12 bounded synthetic trials; standard/lite wire shapes may differ. Catalog costs are not billing. No credentials, URLs, response text or private context retained.",
			}, null, 2) + "\n");
			console.log(`${implementation} ${task.name} round=${round}: ${row.stopReason}, match=${row.success}, ${Math.round(row.elapsedMs)}ms`);
		}
	}
}
process.exitCode = rows.every((row) => row.success) ? 0 : 1;
