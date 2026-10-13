import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

test("OpenAI profiles retain exact Pi 1.2.0 catalog and unchanged chat descriptor evidence", () => {
	const evidence = JSON.parse(readFileSync(new URL("../provenance/pi-openai-120-gpt6.json", import.meta.url), "utf8"));
	const bytes = readFileSync(new URL("./providers/data/openai.json", import.meta.resolve("@earendil-works/pi-ai")));
	assert.equal(createHash("sha256").update(bytes).digest("hex"), evidence.catalogReference.sha256);
	assert.equal(evidence.catalogReference.version, "1.2.0");
	assert.equal(evidence.upstream.revision, "06a466935536f8c9bcacb2d5efc0fc021be1bdff");
	assert.deepEqual(evidence.models, ["openai/gpt-6.1-sol", "openai/gpt-6-astra", "openai/gpt-6-sol", "openai/gpt-6-luna"]);
	const catalog = JSON.parse(bytes.toString("utf8"));
	for (const [id, sha256] of Object.entries(evidence.chatDescriptorSha256)) {
		const descriptor = catalog["openai-responses"][`chat:${id}`];
		assert.equal(createHash("sha256").update(JSON.stringify(descriptor)).digest("hex"), sha256);
	}
	assert.equal(catalog["openai-decisions"]["classifier:gpt-6-luna"].type, "classifier");
	const historical = JSON.parse(readFileSync(new URL("../provenance/pi-openai-0991-gpt6.json", import.meta.url), "utf8"));
	assert.equal(historical.upstream.revision, "d86654abb8862e201933517d6f1fce9f88dd117f");
	assert.deepEqual(evidence.models, historical.models);
	const profiles = JSON.parse(readFileSync(new URL("../src/model-catalog/default-models.json", import.meta.url), "utf8")).models;
	for (const id of evidence.models) assert(profiles.some((profile: { id: string }) => profile.id === id));
	assert(!profiles.some((profile: { id: string }) => profile.id === "openai-codex/gpt-6.1-sol"));
	assert(!profiles.some((profile: { id: string }) => profile.id.includes("*")));
});
