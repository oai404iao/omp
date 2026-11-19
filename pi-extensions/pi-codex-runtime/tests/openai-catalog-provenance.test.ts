import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

test("OpenAI profiles retain exact installed Pi catalog and chat descriptor evidence", () => {
	const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.resolve("@earendil-works/pi-ai")), "utf8"));
	const evidence = JSON.parse(readFileSync(new URL("../provenance/pi-openai-152-gpt6.json", import.meta.url), "utf8"));
	assert.equal(version, evidence.catalogReference.version);
	const bytes = readFileSync(new URL("./providers/data/openai.json", import.meta.resolve("@earendil-works/pi-ai")));
	assert.equal(createHash("sha256").update(bytes).digest("hex"), evidence.catalogReference.sha256);
	const priorBaseline = JSON.parse(readFileSync(new URL("../provenance/pi-openai-120-gpt6.json", import.meta.url), "utf8"));
	assert.equal(priorBaseline.upstream.revision, "06a466935536f8c9bcacb2d5efc0fc021be1bdff");
	const ids = ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"];
	assert.deepEqual(evidence.models, ids.map(id => `openai/${id}`));
	assert.deepEqual(Object.keys(evidence.chatDescriptorSha256).sort(), [...ids].sort());
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
