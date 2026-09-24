import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { normalizeContext } from "@earendil-works/pi-ai";
import { stream as nativeStream } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { createCodexStream } from "@oai404iao/pi-codex-core/internal/providers/openai-codex/stream";

export const model: any = {
	id: "gpt-5.5", provider: "openai-codex", api: "openai-codex-responses",
	baseUrl: "https://codex-ablation.invalid/backend-api", headers: {},
	reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 4096,
	cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1.25 },
};
export const context: any = {
	systemPrompt: "Answer briefly.",
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
	tools: [],
};
export const usage = {
	input_tokens: 100, output_tokens: 10, total_tokens: 110,
	input_tokens_details: { cached_tokens: 30 },
	output_tokens_details: { reasoning_tokens: 5 },
};
export const textItem = {
	type: "message", id: "msg_fixture", role: "assistant", status: "completed",
	phase: "final_answer",
	content: [{ type: "output_text", text: "你好 🌍", annotations: [] }],
};
export function terminal(overrides: Record<string, unknown> = {}): any {
	return { type: "response.completed", response: {
		id: "resp_fixture", status: "completed", output: [textItem], usage: structuredClone(usage), ...overrides,
	} };
}
export function textEvents(): any[] {
	return [
		{ type: "response.created", response: { id: "resp_fixture" } },
		{ type: "response.output_item.added", output_index: 0, item: { ...textItem, content: [] } },
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "你好 🌍" },
		{ type: "response.output_item.done", output_index: 0, item: structuredClone(textItem) },
		terminal(),
	];
}
export function frame(event: any): string {
	return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
export function response(events = textEvents()): Response {
	return new Response(events.map(frame).join(""), { headers: { "content-type": "text/event-stream" } });
}
export async function* iterable(events: any[]): AsyncIterable<any> {
	yield* structuredClone(events);
}
export const implementations = ["native", "extension"] as const;
export type Implementation = typeof implementations[number];

const fakeJwt = `fixture.${Buffer.from(JSON.stringify({
	"https://api.openai.com/auth": { chatgpt_account_id: "acct_offline_fixture" },
})).toString("base64url")}.not-a-signature`;

export function start(implementation: Implementation, options: Record<string, any> = {}) {
	const streamOptions = {
		apiKey: fakeJwt, transport: "sse", timeoutMs: 0, maxRetries: 0, ...options,
	};
	assert.equal(streamOptions.transport, "sse", "This experiment must never open a WebSocket");
	if (implementation === "native") return nativeStream(model, normalizeContext(structuredClone(context)), streamOptions);
	return createCodexStream(model, structuredClone(context), streamOptions, { getCurrentCwd: () => process.cwd() });
}
export async function run(implementation: Implementation, options: Record<string, any> = {}) {
	const stream = start(implementation, options);
	const events: string[] = [];
	for await (const event of stream) events.push(event.type);
	const message = await stream.result();
	assert.equal(events.filter((type) => type === "done" || type === "error").length, 1);
	return { message, events };
}
export function denyFetch(): never {
	throw new Error("Unmocked network access is forbidden in the offline experiment");
}
export async function settle(): Promise<void> {
	await setImmediate();
}
