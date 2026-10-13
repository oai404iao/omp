import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { listResolvedModelProfiles, resolveModelProfile } from "@oai404iao/pi-codex-runtime/internal/model-catalog/catalog";
import { matchesCheckpointProfile } from "../src/adapter/compaction/profile-migration.js";
import { applyNativeCompactionContext, NATIVE_COMPACTION_DETAILS_KIND } from "../src/native-compaction.js";
import { responsesModel as model, withCodexSettings } from "../../../tests/codex/support/provider-lifecycle-test-support.js";

// Persisted at 7edbf751, not recomputed with the current catalog.
const oldestHash = "0170ea402464164e";
const previousHash = "0121c311a15cd358";

for (const [release, hash] of [["oldest", oldestHash], ["previous-current", previousHash]] as const) {
	test(`a fixed ${release} bundled checkpoint replays without rewriting opaque history`, () =>
		withCodexSettings({}, async cwd => {
			const manager = SessionManager.inMemory(cwd);
			manager.appendCompaction("opaque [native-checkpoint:previous-release]", null, 100, {
				kind: NATIVE_COMPACTION_DETAILS_KIND, version: 4, checkpointId: "previous-release",
				mode: "responses", provider: model.provider, model: model.id, api: model.api,
				profileHash: hash, output: [{ type: "compaction", encrypted_content: "HISTORICAL_OPAQUE" }],
			}, true);
			const profile = resolveModelProfile(model)!;
			assert.deepEqual(profile.sources, ["bundled"]);
			assert.equal(profile.profileHash, "6e4ad1e55781fd74");
			assert.notEqual(profile.profileHash, hash);
			const raw = structuredClone(manager.getBranch());
			const messages = manager.buildSessionContext().messages;
			const replay = applyNativeCompactionContext(messages, manager.getBranch(), model);
			assert.match(JSON.stringify(replay), /HISTORICAL_OPAQUE/);
			assert(!replay.some(message => message.role === "compactionSummary"));
			assert.deepEqual(manager.getBranch(), raw, "migration must not rewrite the stored checkpoint");
			assert.throws(() => applyNativeCompactionContext(messages, manager.getBranch(),
				{ ...model, id: "gpt-5.4" }), /original model and profile/);
			assert.throws(() => applyNativeCompactionContext(messages, manager.getBranch(),
				{ ...model, api: "openai-codex-responses" }), /original model and profile/);
			writeFileSync(join(cwd, "extensions/pi-codex-minimal-tools/config.json"),
				JSON.stringify({ openaiTransport: "sse" }));
			assert.throws(() => applyNativeCompactionContext(messages, manager.getBranch(), model),
				/original model and profile/, "unreviewed legacy overrides must not migrate");
		}));
}

test("historical profile migration pins historical and current hashes, identity, and bundled-only provenance", () =>
	withCodexSettings({}, async () => {
		const profile = resolveModelProfile(model)!;
		assert(matchesCheckpointProfile(profile, oldestHash));
		assert(matchesCheckpointProfile(profile, previousHash));
		assert(matchesCheckpointProfile(profile, profile.profileHash));
		assert(!matchesCheckpointProfile(profile, "unrecognized-previous-profile"));
		assert(!matchesCheckpointProfile(profile, "0121c311a15cd359"));
		assert(!matchesCheckpointProfile({ ...profile, profileHash: "future-profile" }, oldestHash));
		assert(!matchesCheckpointProfile({ ...profile, profileHash: "future-profile" }, previousHash));
		assert(!matchesCheckpointProfile({ ...profile, id: "openai/other-model" }, previousHash));
		assert(!matchesCheckpointProfile({ ...profile, sources: ["bundled", "user"] }, previousHash));
		assert(!matchesCheckpointProfile({ ...profile, sources: ["bundled", "legacy"] }, previousHash));
		assert(!matchesCheckpointProfile({ ...profile, sources: ["user"] }, previousHash));
		assert(!matchesCheckpointProfile(undefined, previousHash));
	}));

const historicalProfiles = [
	["openai/gpt-5.6-sol", "3ffd88597175e11a", "6cb0962048490234"],
	["openai/gpt-6.1-sol", "3ffd88597175e11a", "6cb0962048490234"],
	["openai/gpt-5.6-terra", "3ffd88597175e11a", "684fb3bd165b4364"],
	["openai/gpt-5.6-luna", "3ffd88597175e11a", "684fb3bd165b4364"],
	["openai/gpt-5.5", "0170ea402464164e", "0121c311a15cd358"],
	["openai/gpt-5.4", "e020eb8c2dfe85f6", "e1d625d42c91b055"],
	["openai/gpt-5.4-mini", "f7b3b324c901e15d", "332533df2b8142aa"],
	["openai/gpt-5.2", "46448b062babfe16", "91ef9c281a8a9fd4"],
	["openai/codex-auto-review", "f7b3b324c901e15d", "332533df2b8142aa"],
	["openai/gpt-5", "a683eac101e69e40", "f65c8b1a90f592ba"],
	["openai/gpt-5-mini", "46448b062babfe16", "91ef9c281a8a9fd4"],
	["openai/gpt-5.1", "a683eac101e69e40", "f65c8b1a90f592ba"],
	["openai/gpt-5.1-codex", "a683eac101e69e40", "f65c8b1a90f592ba"],
	["openai/gpt-5.3-codex", "f7b3b324c901e15d", "332533df2b8142aa"],
	["openai-codex/gpt-5.6-sol", "edf3dad13ceaa4d6", "848ea196a09d3ab0"],
	["openai-codex/gpt-6-sol", "cadfaef369d49300", "372ef25b035a56bb"],
	["openai-codex/gpt-6-luna", "cadfaef369d49300", "372ef25b035a56bb"],
	["openai-codex/gpt-6-astra", "edf3dad13ceaa4d6", "848ea196a09d3ab0"],
	["openai-codex/gpt-5.6-terra", "edf3dad13ceaa4d6", "7666ef477e06833e"],
	["openai-codex/gpt-5.6-luna", "edf3dad13ceaa4d6", "7666ef477e06833e"],
	["openai-codex/gpt-5.5", "9e7f4d6833f6fa90", "977f83e16ab2bbff"],
	["openai-codex/gpt-5.4", "ffd0ddaf49ad4cbf", "6f61d2933d73bfc1"],
	["openai-codex/gpt-5.4-mini", "1dcd3a7974c50447", "d1a459d86fc49595"],
	["openai-codex/gpt-5.2", "cf9d2786d1ce5bb7", "612c070f776a1741"],
	["openai-codex/codex-auto-review", "1dcd3a7974c50447", "d1a459d86fc49595"],
	["openai-codex/gpt-5", "3d1dde891d4bd92b", "7c181bf37d1b3014"],
	["openai-codex/gpt-5-mini", "cf9d2786d1ce5bb7", "612c070f776a1741"],
	["openai-codex/gpt-5.1", "3d1dde891d4bd92b", "7c181bf37d1b3014"],
	["openai-codex/gpt-5.1-codex", "3d1dde891d4bd92b", "7c181bf37d1b3014"],
	["openai-codex/gpt-5.3-codex", "1dcd3a7974c50447", "d1a459d86fc49595"],
] as const;

test("every bundled Responses checkpoint profile accepts both reviewed historical releases", () =>
	withCodexSettings({}, async () => {
		const profiles = listResolvedModelProfiles().filter(profile => profile.effective.compaction === "responses");
		assert.deepEqual(profiles.map(profile => profile.id).sort(), historicalProfiles.map(([id]) => id).sort());
		for (const [id, oldest, previous] of historicalProfiles) {
			const profile = profiles.find(profile => profile.id === id)!;
			assert(matchesCheckpointProfile(profile, oldest), `${id}: oldest checkpoint`);
			assert(matchesCheckpointProfile(profile, previous), `${id}: previous-current checkpoint`);
			assert(!matchesCheckpointProfile({ ...profile, profileHash: "future-profile" }, previous), id);
		}
	}));

test("custom and user-overridden profiles cannot migrate bundled checkpoint hashes", () =>
	withCodexSettings({}, async cwd => {
		writeFileSync(join(cwd, "extensions/pi-codex-minimal-tools/models.json"),
			JSON.stringify({ version: 1, models: [
				{ id: "custom/checkpoint-fixture", extends: "openai/gpt-5.5" },
				{ id: "openai/gpt-5.5", tools: { parallelCalls: false } },
			] }));
		for (const candidate of [model, { provider: "custom", id: "checkpoint-fixture" }]) {
			const profile = resolveModelProfile(candidate)!;
			assert(profile.sources.includes("user"));
			assert(!matchesCheckpointProfile(profile, oldestHash));
			assert(!matchesCheckpointProfile(profile, previousHash));
		}
	}));
