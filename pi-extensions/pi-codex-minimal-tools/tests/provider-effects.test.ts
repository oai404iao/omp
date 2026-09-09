import assert from "node:assert/strict";
import test from "node:test";
import { processCapturedResponsesStream } from "../src/providers/openai-codex/captured-stream.js";
import type { ProviderStreamEffects } from "../src/providers/openai-codex/stream-effects.js";
import type { StreamEventShape } from "../src/providers/openai-codex/types.js";
import { convertResponsesMessages } from "../src/providers/responses/messages.js";
import { decodeWebSearchActivityTextSignature } from "../src/providers/responses/signatures.js";
import { createWebSearchCapture } from "../src/tools/web-search/capture.js";
import { captureContext, deferred, responsesModel } from "./support/provider-lifecycle-test-support.js";

const image = Object.freeze({ type: "image_generation_call", id: "ig_one", status: "completed", result: "cG5n" });
const compaction = Object.freeze({ type: "compaction", encrypted_content: "checkpoint" });

async function* nativeEvents(): AsyncIterable<StreamEventShape> {
	yield { type: "response.created", response: { id: "resp_one" } };
	yield { type: "response.output_item.done", output_index: 0, item: image };
	// The mapper must surface terminal-only compaction before completion.
	yield { type: "response.done", response: { id: "resp_one", status: "completed", output: [image, compaction] } };
}

function run(context: ReturnType<typeof captureContext>, effects: ProviderStreamEffects = {}) {
	return processCapturedResponsesStream(
		nativeEvents(), context.output, context.stream, responsesModel,
		{ signal: context.signal }, undefined, effects, context.cwd, context.requestPrompt, [], [],
	);
}

test("without effects, normalized native items still survive continuation and replay", async () => {
	const context = captureContext();
	const result = await run(context);
	assert.equal(result.responseId, "resp_one");
	assert.deepEqual(result.responseItems, [image, compaction]);
	assert.equal(result.responseItems[0], image);
	assert.deepEqual(context.output.content.map(block => block.type), ["image_generation_call", "thinking"]);
	assert.deepEqual(convertResponsesMessages(responsesModel, {
		messages: [context.output],
	}, new Set(["openai"])), [image, compaction]);
	assert.equal(context.events.length, 0, "native replay does not require a presentation event");
});

test("observers see normalized events and are awaited before replay parsing", async () => {
	const context = captureContext();
	const entered = deferred<void>();
	const resume = deferred<void>();
	const seen: string[] = [];
	const pending = run(context, {
		createEventObserver(input) {
			assert.equal(input.output, context.output);
			assert.equal(input.requestPrompt, "request prompt");
			return async event => {
				seen.push(event.type!);
				if (event.item?.type === "image_generation_call") {
					entered.resolve();
					await resume.promise;
				}
			};
		},
	});
	await entered.promise;
	try {
		assert.equal(context.output.content.length, 0);
	} finally {
		resume.resolve();
	}
	await pending;
	assert.deepEqual(seen, [
		"response.created", "response.output_item.done", "response.output_item.done", "response.completed",
	]);
});

test("observers are response-local and uncaught observer errors close the upstream iterator", async () => {
	let finalized = false;
	async function* events(): AsyncIterable<StreamEventShape> {
		try {
			yield { type: "response.created", response: { id: "resp_failure" } };
		} finally {
			finalized = true;
		}
	}
	const context = captureContext();
	await assert.rejects(processCapturedResponsesStream(
		events(), context.output, context.stream, responsesModel, undefined, undefined,
		{ createEventObserver: () => () => { throw new Error("observer failed"); } },
		context.cwd, undefined, [], [],
	), /observer failed/);
	assert.equal(finalized, true);

	let factories = 0;
	const effects: ProviderStreamEffects = {
		createEventObserver() {
			factories++;
			let created = false;
			return event => {
				if (event.type === "response.created") {
					assert.equal(created, false);
					created = true;
				} else assert.equal(created, true);
			};
		},
	};
	await Promise.all([run(captureContext(), effects), run(captureContext(), effects)]);
	assert.equal(factories, 2);
});

test("web activity state and replay signatures belong to each observer, including late progress", () => {
	const first = captureContext();
	const second = captureContext();
	const observeFirst = createWebSearchCapture(first);
	const observeSecond = createWebSearchCapture(second);
	const search = (query: string): StreamEventShape["item"] => ({
		type: "web_search_call", id: "ws_same", status: "completed",
		action: { type: "search", query },
	});
	observeFirst({ type: "response.output_item.done", item: search("first query") });
	observeSecond({ type: "response.output_item.done", item: search("second query") });
	observeFirst({ type: "response.web_search_call.searching", item_id: "ws_same" });
	for (const [context, query] of [[first, "first query"], [second, "second query"]] as const) {
		assert.equal(context.output.content.length, 1);
		const block = context.output.content[0]!;
		assert.equal(block.type, "text");
		if (block.type !== "text") throw new Error("Expected activity text");
		assert.match(block.text, /Searched the web/);
		assert.ok(block.text.includes(query));
		assert.equal(decodeWebSearchActivityTextSignature(block.textSignature)?.action.query, query);
	}
	assert.deepEqual(first.events.map(event => event.type), ["text_start", "text_delta", "text_delta"]);
	assert.deepEqual(second.events.map(event => event.type), ["text_start", "text_delta"]);
});
