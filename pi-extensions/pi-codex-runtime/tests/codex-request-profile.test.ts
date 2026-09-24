import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CODEX_REQUEST_PROFILE, resolveCodexRequestProfile } from "@oai404iao/pi-codex-runtime/internal/codex-request-profile";

test("Codex request profile defaults to Standard Responses function tools", () => {
	assert.deepEqual(resolveCodexRequestProfile(), DEFAULT_CODEX_REQUEST_PROFILE);
	assert.equal(resolveCodexRequestProfile().patchTransport, "function");
});

test("Codex request profile applies supported explicit overrides", () => {
	assert.deepEqual(resolveCodexRequestProfile({
		responsesMode: "standard",
		reasoningSummary: "detailed",
		systemPromptPlacement: "developer",
		patchTransport: "function",
		supportsHostedTools: false,
		supportsParallelTools: false,
	}), {
		responsesMode: "standard",
		reasoningSummary: "detailed",
		systemPromptPlacement: "developer",
		patchTransport: "function",
		supportsHostedTools: false,
		supportsParallelTools: false,
	});
});

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

test("reasoning summary uses mode defaults and preserves explicit overrides", () => {
	assert.equal(resolveCodexRequestProfile().reasoningSummary, "auto");
	assert.equal(resolveCodexRequestProfile({ responsesMode: "lite" }).reasoningSummary, "none");
	assert.equal(
		resolveCodexRequestProfile({ responsesMode: "lite", reasoningSummary: "detailed" }).reasoningSummary,
		"detailed",
	);
	assert.equal(resolveCodexRequestProfile({ reasoningSummary: "none" }).reasoningSummary, "none");
});

test("custom patch transport is opt-in while function remains the default", () => {
	assert.equal(resolveCodexRequestProfile().patchTransport, "function");
	assert.equal(resolveCodexRequestProfile({ patchTransport: "custom" }).patchTransport, "custom");
});

test("system prompt placement defaults to instructions and accepts developer", () => {
	assert.equal(resolveCodexRequestProfile().systemPromptPlacement, "instructions");
	assert.equal(resolveCodexRequestProfile({ systemPromptPlacement: "developer" }).systemPromptPlacement, "developer");
	assert.equal(resolveCodexRequestProfile({ responsesMode: "lite", systemPromptPlacement: "instructions" }).systemPromptPlacement, "developer");
});
