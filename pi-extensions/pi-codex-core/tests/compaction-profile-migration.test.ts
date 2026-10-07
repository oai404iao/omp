import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveModelProfile } from "@oai404iao/pi-codex-runtime/internal/model-catalog/catalog";
import { matchesCheckpointProfile } from "../src/adapter/compaction/profile-migration.js";
import { applyNativeCompactionContext, NATIVE_COMPACTION_DETAILS_KIND } from "../src/native-compaction.js";
import { responsesModel as model, withCodexSettings } from "../../../tests/codex/support/provider-lifecycle-test-support.js";

// Persisted at 7edbf751, not recomputed with the current catalog.
const previousHash = "0170ea402464164e";

test("a fixed previous-release bundled checkpoint replays without rewriting opaque history", () =>
	withCodexSettings({}, async cwd => {
		const manager = SessionManager.inMemory(cwd);
		manager.appendCompaction("opaque [native-checkpoint:previous-release]", null, 100, {
			kind: NATIVE_COMPACTION_DETAILS_KIND, version: 4, checkpointId: "previous-release",
			mode: "responses", provider: model.provider, model: model.id, api: model.api,
			profileHash: previousHash, output: [{ type: "compaction", encrypted_content: "HISTORICAL_OPAQUE" }],
		}, true);
		const profile = resolveModelProfile(model)!;
		assert.deepEqual(profile.sources, ["bundled"]);
		assert.equal(profile.profileHash, "0121c311a15cd358");
		assert.notEqual(profile.profileHash, previousHash);
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

test("historical profile migration pins both hashes, identity, and bundled-only provenance", () =>
	withCodexSettings({}, async () => {
		const profile = resolveModelProfile(model)!;
		assert(matchesCheckpointProfile(profile, previousHash));
		assert(matchesCheckpointProfile(profile, profile.profileHash));
		assert(!matchesCheckpointProfile(profile, "unrecognized-previous-profile"));
		assert(!matchesCheckpointProfile({ ...profile, profileHash: "future-profile" }, previousHash));
		assert(!matchesCheckpointProfile({ ...profile, id: "openai/other-model" }, previousHash));
		assert(!matchesCheckpointProfile({ ...profile, sources: ["bundled", "user"] }, previousHash));
		assert(!matchesCheckpointProfile({ ...profile, sources: ["bundled", "legacy"] }, previousHash));
		assert(!matchesCheckpointProfile(undefined, previousHash));
	}));
