import assert from "node:assert/strict";
import test from "node:test";
import { buildCodexCompactionCheckpoint } from "@oai404iao/pi-codex-core/internal/adapter/compaction/checkpoint";
import { APPROX_BYTES_PER_TOKEN, CODEX_RETAINED_MESSAGE_TOKEN_BUDGET } from "@oai404iao/pi-codex-core/internal/providers/openai-codex/constants";

const retainedBytes = CODEX_RETAINED_MESSAGE_TOKEN_BUDGET * APPROX_BYTES_PER_TOKEN;
const text = (value: string) => ({ type: "input_text", text: value });
const image = (data: string) => ({ type: "input_image", image_url: `data:image/png;base64,${data}` });
const user = (...content: unknown[]) => ({ type: "message", role: "user", content });

test("compaction drops oversized media without losing surrounding text or altering opaque state", () => {
	const oversized = image("AAAA".repeat(CODEX_RETAINED_MESSAGE_TOKEN_BUDGET));
	const small = image("AQID");
	const file = { type: "input_file", filename: "notes.txt", file_data: "A".repeat(retainedBytes), text: "description" };
	const before = text("Look at these attachments");
	const after = text("Focus on the small image");
	const earlier = user(text("earlier context"));
	const opaque = Object.freeze({ type: "context_compaction", encrypted_content: "A".repeat(retainedBytes + 1) });

	const checkpoint = buildCodexCompactionCheckpoint([
		earlier,
		user(oversized),
		user(before, oversized, small, file, after),
	], opaque);

	assert.deepEqual(checkpoint.slice(0, -1), [earlier, user(before, small, after)]);
	assert.equal(checkpoint.at(-1), opaque);
});

test("retained media shares the budget across messages, newest first", () => {
	const data = "AAAA".repeat(Math.floor(CODEX_RETAINED_MESSAGE_TOKEN_BUDGET * 0.6));
	const older = image(data.replace(/^AAAA/, "AQID"));
	const newer = image(data);
	const explanation = text("what the older image showed");
	const latest = user(newer);
	const opaque = { type: "compaction", encrypted_content: "opaque" };

	const checkpoint = buildCodexCompactionCheckpoint([user(older, explanation), latest], opaque);

	assert.deepEqual(checkpoint, [user(explanation), latest, opaque]);
});

test("text-only retention still takes a UTF-8-safe prefix at the budget boundary", () => {
	const opaque = { type: "compaction", encrypted_content: "opaque" };
	const boundaryText = "a" + "🎯".repeat(CODEX_RETAINED_MESSAGE_TOKEN_BUDGET);
	const latest = user(text("new text"));
	const checkpoint = buildCodexCompactionCheckpoint([user(text(boundaryText)), latest], opaque);

	assert.deepEqual(checkpoint, [
		user(text("a" + "🎯".repeat(CODEX_RETAINED_MESSAGE_TOKEN_BUDGET - 3))),
		latest,
		opaque,
	]);
});
