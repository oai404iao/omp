import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessage as createInitialAssistantMessage } from "../../../tests/codex/support/provider-lifecycle-test-support.js";
import { finalizeResponseUsage } from "@oai404iao/pi-codex-runtime/internal/providers/responses/usage";
import { convertResponsesMessages } from "@oai404iao/pi-codex-runtime/internal/providers/responses/messages";
import { processResponsesStream } from "@oai404iao/pi-codex-runtime/internal/providers/responses/stream";

const model = {
	provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.5",
	input: ["text"], reasoning: true,
	cost: { input: 1e6, output: 2e6, cacheRead: 3e6, cacheWrite: 4e6 },
} as any;

test("usage separates cache writes, preserves reasoning totals and applies pricing once", () => {
	const output = createInitialAssistantMessage(model);
	let calls = 0;
	finalizeResponseUsage({
		status: "completed", service_tier: "priority",
		usage: {
			input_tokens: 100, output_tokens: 10, total_tokens: 110,
			input_tokens_details: { cached_tokens: 30, cache_write_tokens: 20 },
			output_tokens_details: { reasoning_tokens: 5 },
		},
	} as any, model, output, {
		applyServiceTierPricing(usage, tier) {
			calls++;
			assert.equal(tier, "priority");
			assert.equal(usage.cost.total, 240);
			for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) usage.cost[key] *= 2;
		},
	});
	assert.equal(calls, 1);
	assert.deepEqual([output.usage.input, output.usage.output, output.usage.cacheRead, output.usage.cacheWrite], [50, 10, 30, 20]);
	assert.equal(output.usage.reasoning, 5);
	assert.equal(output.usage.totalTokens, 110);
	assert.equal(output.usage.cost.total, 480);
});

test("usage clamps inconsistent input counters and accepts missing cache details", () => {
	for (const [details, input] of [[{ cached_tokens: 30, cache_write_tokens: 20 }, 0], [undefined, 10]] as const) {
		const output = createInitialAssistantMessage(model);
		finalizeResponseUsage({
			status: "completed", usage: { input_tokens: 10, output_tokens: 0, total_tokens: 10, input_tokens_details: details },
		} as any, model, output);
		assert.equal(output.usage.input, input);
		assert.ok(output.usage.cost.input >= 0);
	}
});

test("terminal reasoning backfill is ID-specific, preserves opaque signatures and survives replay", async () => {
	const first = { type: "reasoning", id: "rs_first", summary: [{ type: "summary_text", text: "first" }] };
	const second = { type: "reasoning", id: "rs_second", encrypted_content: "already-present", summary: [] };
	const compaction = { type: "compaction", id: "rs_first", encrypted_content: "compaction-opaque" };
	const output = createInitialAssistantMessage(model);
	async function* events(): AsyncIterable<any> {
		yield { type: "response.output_item.done", output_index: 0, item: first };
		yield { type: "response.output_item.done", output_index: 1, item: second };
		yield { type: "response.output_item.done", output_index: 2, item: compaction };
		yield { type: "response.completed", response: { status: "completed", output: [
			{ ...second, encrypted_content: "must-not-overwrite" },
			{ ...first, encrypted_content: "late-encrypted" },
		] } };
	}
	await processResponsesStream(events(), output, { push() {} } as any, model);
	const replay = convertResponsesMessages(model, { messages: [output] }, new Set(["openai-codex"])) as any[];
	assert.deepEqual(replay, [
		{ ...first, encrypted_content: "late-encrypted" }, second, compaction,
	]);
});
