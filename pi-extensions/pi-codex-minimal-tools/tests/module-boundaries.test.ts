import assert from "node:assert/strict";
import test from "node:test";
import * as shim from "../src/provider-shim.js";
import * as responses from "../src/providers/openai-responses-shared.js";

// This is the pre-refactor runtime surface, not a glob of current exports.
const shimOwners = {
	"adapter/compaction/checkpoint": ["buildCodexCompactionCheckpoint", "sanitizeNativeCompactionOutput"],
	"adapter/compaction/request": ["requestOpenAINativeCompaction"],
	"extension/register": ["registerOpenAIResponsesProviders"],
	"providers/openai-codex/errors": ["buildProviderErrorMessage", "withHttpStatusPrefix"],
	"providers/openai-codex/headers": ["buildSSEHeaders", "buildWebSocketHeaders"],
	"providers/openai-codex/lite": ["withResponsesLiteWebSocketMetadata"],
	"providers/openai-codex/proxy": ["proxyForWebSocketUrl", "webSocketOptionsForUrl"],
	"providers/openai-codex/request-body": ["buildRequestBody"],
	"providers/openai-codex/request-metadata": ["withSseRequestMetadata"],
	"providers/openai-codex/sse": ["fetchWithResponseHeaderTimeout", "responseHeaderTimeoutMsFromOptions"],
	"providers/openai-codex/urls": ["resolveCodexUrl", "resolveResponsesWebSocketUrl"],
	"providers/openai-codex/websocket-events": ["sendWebSocketRequest"],
	"providers/openai-codex/websocket-session": ["closeProviderWebSocketSessions"],
	"tools/image-generation/storage": [
		"buildGeneratedImageDisplayText", "getOpenAICodexImageDirectory", "getOpenAICodexImagePath",
		"getOpenAICodexLatestImagePath", "saveOpenAICodexGeneratedImage",
	],
	"tools/image-generation/types": ["IMAGE_SAVE_DISPLAY_MESSAGE_TYPE"],
	"tools/web-search/activity": [
		"WEB_SEARCH_ACTIVITY_MESSAGE_TYPE", "buildWebSearchActivityMessage", "buildWebSearchInlineText",
		"buildWebSearchStatusText", "buildWebSearchSummaryText", "extractWebSearch", "extractWebSearchProgress",
		"mergeWebSearchActivity", "webSearchActivityDetail", "webSearchActivityHosts",
	],
};
const responsesOwners = {
	"providers/responses/citations": [
		"collectHistoricalCitationSources", "collectWebSearchCitationSources", "extractWebSearchCitationSources",
	],
	"providers/responses/messages": ["convertResponsesMessages"],
	"providers/responses/signatures": [
		"WEB_SEARCH_ACTIVITY_TEXT_SIGNATURE_PREFIX", "decodeWebSearchActivityTextSignature",
		"encodeWebSearchActivityTextSignature", "isWebSearchActivityTextSignature",
	],
	"providers/responses/stream": ["processResponsesStream"],
	"providers/responses/tools": ["convertResponsesTools"],
};

async function assertFacade(facade: Record<string, unknown>, owners: Record<string, string[]>) {
	assert.deepEqual(Object.keys(facade).sort(), Object.values(owners).flat().sort());
	for (const [path, names] of Object.entries(owners)) {
		const implementation = await import(`../src/${path}.js`);
		for (const name of names) {
			assert.equal(facade[name], implementation[name], `${name} must share its owning implementation`);
		}
	}
}

test("provider shim preserves exactly its existing exports without wrapping or copying state", async () => {
	await assertFacade(shim, shimOwners);
});

test("Responses facade preserves exactly its existing exports", async () => {
	await assertFacade(responses, responsesOwners);
});
