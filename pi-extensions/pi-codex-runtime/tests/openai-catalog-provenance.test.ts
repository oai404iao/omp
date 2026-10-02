import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

test("new OpenAI profiles retain the exact Pi 0.99.1 descriptor evidence", () => {
	const evidence = JSON.parse(readFileSync(new URL("../provenance/pi-openai-0991-gpt6.json", import.meta.url), "utf8"));
	const bytes = readFileSync(new URL("./providers/data/openai.json", import.meta.resolve("@earendil-works/pi-ai")));
	assert.equal(createHash("sha256").update(bytes).digest("hex"), evidence.catalogReference.sha256);
	assert.equal(evidence.upstream.revision, "d86654abb8862e201933517d6f1fce9f88dd117f");
	assert.deepEqual(evidence.models, ["openai/gpt-6.1-sol", "openai/gpt-6-astra", "openai/gpt-6-sol", "openai/gpt-6-luna"]);
	const profiles = JSON.parse(readFileSync(new URL("../src/model-catalog/default-models.json", import.meta.url), "utf8")).models;
	for (const id of evidence.models) assert(profiles.some((profile: { id: string }) => profile.id === id));
	assert(!profiles.some((profile: { id: string }) => profile.id === "openai-codex/gpt-6.1-sol"));
	assert(!profiles.some((profile: { id: string }) => profile.id.includes("*")));
});
