import assert from "node:assert/strict";
import test from "node:test";
import { responseHeaderTimeoutMsFromOptions } from "@oai404iao/pi-codex-core/internal/providers/openai-codex/sse";

test("responseHeaderTimeoutMsFromOptions uses Pi HTTP timeout when provided", () => {
	assert.equal(responseHeaderTimeoutMsFromOptions({ timeoutMs: 45_000 } as any), 45_000);
	assert.equal(responseHeaderTimeoutMsFromOptions({ timeoutMs: 0 } as any), 20_000);
	assert.equal(responseHeaderTimeoutMsFromOptions(undefined), 20_000);
});
