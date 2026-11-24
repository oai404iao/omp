import assert from "node:assert/strict";
import test from "node:test";
import { createCodexReservedNamespaceTool } from "@oai404iao/pi-codex-runtime/internal/codex-reserved-tools";
import { rewriteNativeOpenAiTools } from "@oai404iao/pi-codex-core/internal/provider-native-tools";

test("Codex reserved namespace definitions are cloned per request", () => {
	const first = createCodexReservedNamespaceTool("web_search");
	first.tools[0]!.description = "mutated";
	assert.notEqual(createCodexReservedNamespaceTool("web_search").tools[0]!.description, "mutated");
});

test("hosted web_search defaults to live and serializes Codex modes and content types", () => {
	const payload = { tools: [{ type: "function", name: "web_search", description: "Pi placeholder", parameters: {} }] };
	const location = { type: "approximate", country: "US", timezone: "America/Los_Angeles" } as const;
	for (const [mode, access] of [
		[undefined, { external_web_access: true }],
		["cached", { external_web_access: false }],
		["indexed", { external_web_access: true, indexed_web_access: true }],
		["live", { external_web_access: true }],
	] as const) {
		const { payload: text } = rewriteNativeOpenAiTools(payload, {
			hostedWebSearchMode: mode,
			webSearch: { implementation: "hosted", contentTypes: ["text"] },
		});
		assert.deepEqual(text.tools, [{ type: "web_search", ...access }]);
		const { payload: multimodal } = rewriteNativeOpenAiTools(payload, {
			hostedWebSearchMode: mode,
			webSearch: { implementation: "hosted", contentTypes: ["image", "text"], searchContextSize: "low",
				userLocation: location, filters: { allowedDomains: ["example.com"] } },
		});
		assert.deepEqual(multimodal.tools, [{
			type: "web_search", ...access, search_content_types: ["text", "image"], search_context_size: "low",
			user_location: location, filters: { allowed_domains: ["example.com"] },
		}]);
	}
});

test("hosted web_search does not expand an image-only profile to text or change a foreign tool", () => {
	const payload = { tools: [{ type: "function", name: "web_search" }, { type: "function", name: "read" }] };
	const webSearch = { implementation: "hosted", contentTypes: ["image"] } as const;
	const options = { webSearch: { ...webSearch, contentTypes: [...webSearch.contentTypes] } };
	const owned = rewriteNativeOpenAiTools(payload, { ...options, ownsNativeTool: () => true });
	assert.deepEqual(owned.payload.tools, [payload.tools[1]]);
	assert.deepEqual(owned.removed, ["web_search"]);
	const foreign = rewriteNativeOpenAiTools(payload, { ...options, ownsNativeTool: () => false });
	assert.deepEqual(foreign.payload, payload);
	assert.deepEqual(foreign.removed, []);
});

test("rewriteNativeOpenAiTools rewrites image_generation only to a standalone namespace", () => {
	const payload = {
		tools: [
			{ type: "function", name: "image_generation", parameters: { output_format: "webp" } },
			{ type: "function", function: { name: "web_search", parameters: {} } },
			{ type: "function", name: "read" },
		],
	};
	const result = rewriteNativeOpenAiTools(payload, { imageGeneration: "standalone" });
	assert.deepEqual(result.rewritten, ["image_generation"]);
	assert.deepEqual(result.payload.tools[0], createCodexReservedNamespaceTool("image_generation"));
	assert.deepEqual(result.payload.tools[1], { type: "function", function: { name: "web_search", parameters: {} } });
	assert.equal((result.payload.tools[2] as any).name, "read");
});

test("rewriteNativeOpenAiTools removes only a disabled tool owned by this package", () => {
	const image = { type: "function", name: "image_generation", parameters: {} };
	const read = { type: "function", name: "read", parameters: {} };
	const owned = rewriteNativeOpenAiTools({ tools: [image, read] }, {
		ownsNativeTool: name => name === "image_generation",
		imageGeneration: false,
	});
	assert.deepEqual(owned.rewritten, []);
	assert.deepEqual(owned.removed, ["image_generation"]);
	assert.deepEqual(owned.payload.tools, [read]);

	const external = rewriteNativeOpenAiTools({ tools: [image] }, {
		ownsNativeTool: () => false,
		imageGeneration: false,
	});
	assert.deepEqual(external.removed, []);
	assert.deepEqual(external.payload.tools, [image]);
});

test("rewriteNativeOpenAiTools emits Codex namespace tools for standalone profiles", () => {
	const payload = {
		tools: [
			{
				type: "function",
				name: "web_search",
				description: "Search the web",
				parameters: { type: "object", properties: {} },
			},
			{
				type: "function",
				name: "image_generation",
				description: "Generate an image",
				parameters: { type: "object", properties: { prompt: { type: "string" } } },
			},
		],
	};
	const result = rewriteNativeOpenAiTools(payload, {
		webSearch: { implementation: "standalone", contentTypes: ["text", "image"] },
		imageGeneration: "standalone",
	});
	assert.deepEqual(result.rewritten, ["web_search", "image_generation"]);
	assert.deepEqual(result.payload.tools, [
		createCodexReservedNamespaceTool("web_search"),
		createCodexReservedNamespaceTool("image_generation"),
	]);
});
