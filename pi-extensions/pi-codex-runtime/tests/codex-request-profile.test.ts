import assert from "node:assert/strict";
import test from "node:test";
import { resolveCodexRequestProfile } from "@oai404iao/pi-codex-runtime/internal/codex-request-profile";

test("Responses Lite forces hosted and parallel tools off", () => {
	assert.deepEqual(resolveCodexRequestProfile({
		responsesMode: "lite",
		supportsHostedTools: true,
		supportsParallelTools: true,
	}), {
		responsesMode: "lite",
		reasoningSummary: "none",
		systemPromptPlacement: "developer",
		patchTransport: "function",
		supportsHostedTools: false,
		supportsParallelTools: false,
	});
});

test("system prompt placement is developer in both Responses envelopes", () => {
	assert.equal(resolveCodexRequestProfile().systemPromptPlacement, "developer");
	assert.equal(resolveCodexRequestProfile({ systemPromptPlacement: "developer" }).systemPromptPlacement, "developer");
	assert.equal(resolveCodexRequestProfile({ systemPromptPlacement: "instructions" }).systemPromptPlacement, "developer");
	assert.equal(resolveCodexRequestProfile({ responsesMode: "lite", systemPromptPlacement: "instructions" }).systemPromptPlacement, "developer");
});
