import assert from "node:assert/strict";
import test from "node:test";
import { recentSearchInput } from "@oai404iao/pi-codex-web-search/internal/tools/web-search/history";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

function entries(messages: unknown[]): SessionEntry[] {
	return messages.map((message, index) => ({
		type: "message", id: `m${index}`, parentId: index ? `m${index - 1}` : null,
		timestamp: new Date(index).toISOString(), message,
	})) as SessionEntry[];
}
const user = (text: string) => ({ role: "user", content: text, timestamp: 0 });
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: 0 });

test("recent search input omits empty/no-user history and ends at the latest visible user", () => {
	assert.equal(recentSearchInput([]), undefined);
	assert.equal(recentSearchInput(entries([assistant("no user")])), undefined);
	assert.equal(recentSearchInput(entries([user("<environment_context>hidden</environment_context>")])), undefined);
	const result = recentSearchInput(entries([
		user("old"), assistant("old answer"),
		user("previous"), assistant("previous answer"),
		user("current"), assistant("must not leak"),
		user("<environment_context>hidden</environment_context>"),
	]), "turn_current");
	assert.deepEqual(result, [
		{ type: "message", role: "user", content: [{ type: "input_text", text: "previous" }] },
		{ type: "message", role: "assistant", content: [{ type: "output_text", text: "previous answer" }] },
		{ type: "message", role: "user", content: [{ type: "input_text", text: "current" }],
			internal_chat_message_metadata_passthrough: { turn_id: "turn_current" } },
	]);
});

test("history preserves available source metadata, phases and text blocks without mutating source", () => {
	const history = entries([
		{ ...user("previous"), internal_chat_message_metadata_passthrough: { turn_id: "turn_previous", create_time: 1.25 } },
		{ role: "assistant", content: [{ type: "text", text: "visible", textSignature: JSON.stringify({
			v: 2, item: {
				type: "message", role: "assistant", id: "msg_fixture", status: "completed",
				phase: "partial_answer",
				content: [{ type: "output_text", text: "original response text", annotations: [] }],
				internal_chat_message_metadata_passthrough: { turn_id: "turn_previous", create_time: 2 },
			},
		}) }], timestamp: 0 },
		{ role: "user", content: [{ type: "text", text: "current first" }, { type: "image", data: "ignored", mimeType: "image/png" },
			{ type: "text", text: "current second" }],
			internal_chat_message_metadata_passthrough: { turn_id: "persisted_current", create_time: 3 }, timestamp: 0 },
	]);
	const original = structuredClone(history);
	const result = recentSearchInput(history, "must_not_overwrite");
	assert.deepEqual(result?.map(message => message.internal_chat_message_metadata_passthrough), [
		{ turn_id: "turn_previous", create_time: 1.25 },
		{ turn_id: "turn_previous", create_time: 2 },
		{ turn_id: "persisted_current", create_time: 3 },
	]);
	assert.equal(result?.[1]?.phase, "partial_answer");
	assert.deepEqual(result?.[1]?.content, [{ type: "output_text", text: "original response text", annotations: [] }]);
	assert.deepEqual(result?.[2]?.content, [
		{ type: "input_text", text: "current first" }, { type: "input_text", text: "current second" },
	]);
	assert.deepEqual(history, original);
});

test("assistant budget matches upstream UTF-8 approximate tokens and middle truncation", () => {
	const result = recentSearchInput(entries([
		user("previous"), assistant("😀".repeat(1001)), assistant("budget exhausted"), user("current"),
	]));
	assert.equal(result?.length, 3);
	assert.equal(result?.[1]?.content[0]?.text, `${"😀".repeat(500)}…1 tokens truncated…${"😀".repeat(500)}`);
	assert(!String(result?.[1]?.content[0]?.text).includes("\ufffd"));
	const shared = recentSearchInput(entries([
		user("previous"), assistant("a".repeat(3999)), assistant("not retained"), user("current"),
	]));
	assert.equal(shared?.length, 3, "ceil(byte_count/4) consumes the full 1000-token budget");
	assert.equal(shared?.[1]?.content[0]?.text, "a".repeat(3999));
});

test("search activity and thinking blocks are not visible conversation text", () => {
	const result = recentSearchInput(entries([
		user("previous"),
		{ role: "assistant", content: [
			{ type: "thinking", thinking: "secret" },
			{ type: "text", text: "searching", textSignature: "pi:web-search-activity:search-1" },
			{ type: "text", text: "actual answer" },
		], timestamp: 0 },
		user("current"),
	]));
	assert.deepEqual(result?.[1]?.content, [{ type: "output_text", text: "actual answer" }]);
});
