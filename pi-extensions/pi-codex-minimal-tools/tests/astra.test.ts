import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildRequestBody } from "@oai404iao/pi-codex-core/internal/providers/openai-codex/request-body";
import { OPENAI_CODEX_ASTRA_MODEL } from "@oai404iao/pi-codex-core/internal/providers/openai-codex/model-catalog";
import { resolveCodexRequestProfile } from "@oai404iao/pi-codex-runtime/internal/codex-request-profile";
import { loadModelSettings } from "@oai404iao/pi-codex-runtime/internal/model-catalog/runtime";
import { DEFAULT_SETTINGS } from "@oai404iao/pi-codex-runtime/internal/settings";

function withAgentDir<T>(run: () => T): T {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const agentDir = mkdtempSync(join(tmpdir(), "pi-codex-astra-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		return run();
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	}
}

const tools = [
	{
		name: "apply_patch",
		description: "Apply a patch",
		parameters: { type: "object", properties: { input: { type: "string" } } },
	},
	{
		name: "web_search",
		description: "Search",
		parameters: { type: "object", properties: {} },
	},
	{
		name: "image_generation",
		description: "Generate an image",
		parameters: { type: "object", properties: { prompt: { type: "string" } } },
	},
];

test("Astra uses the exact Codex Responses Lite request profile", () => withAgentDir(() => {
	const settings = loadModelSettings(
		OPENAI_CODEX_ASTRA_MODEL,
		undefined,
		DEFAULT_SETTINGS,
	);
	const profile = resolveCodexRequestProfile(settings.requestProfile);
	const body = buildRequestBody(
		OPENAI_CODEX_ASTRA_MODEL,
		{
			systemPrompt: "system",
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
			tools,
		},
		profile,
		{
			ownsNativeTool: () => true,
			imageGeneration: settings.imageGenerationImplementation ?? false,
		},
	);

	assert.equal(settings.openaiTransport, "auto");
	assert.equal(settings.openaiWebSocketPrewarm, true);
	assert.equal(settings.compactionMode, "responses");
	assert.equal(body.parallel_tool_calls, false);
	assert.deepEqual(body.text, { verbosity: "low" });
	assert.deepEqual(body.reasoning, { context: "all_turns", effort: "low" });
	assert.equal(body.instructions, undefined);
	assert.equal(body.tools, undefined);
	const additionalTools = body.input[0] as { type: string; tools: Array<{ name: string; tools: Array<{ type: string; name: string }> }> };
	assert.equal(additionalTools.type, "additional_tools");
	assert.deepEqual(additionalTools.tools.map(namespace => namespace.name), [
		"functions",
		"web",
		"image_gen",
	]);
	assert.deepEqual(
		additionalTools.tools.find(namespace => namespace.name === "functions")?.tools.map(tool => [tool.type, tool.name]),
		[["custom", "apply_patch"]],
	);
}));

test("Astra exposes every Pi-supported reasoning effort without inventing ultra", () => withAgentDir(() => {
	assert.deepEqual(OPENAI_CODEX_ASTRA_MODEL.thinkingLevelMap, {
		off: null,
		minimal: "low",
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: "max",
	});
	const settings = loadModelSettings(OPENAI_CODEX_ASTRA_MODEL, undefined, DEFAULT_SETTINGS);
	const body = buildRequestBody(
		OPENAI_CODEX_ASTRA_MODEL,
		{ messages: [], tools: [] },
		resolveCodexRequestProfile(settings.requestProfile),
		{ reasoning: "max" },
	);
	assert.deepEqual(body.reasoning, { context: "all_turns", effort: "max" });
}));

test("image gate removes the package-owned Lite namespace", () => withAgentDir(() => {
	const settings = loadModelSettings(
		OPENAI_CODEX_ASTRA_MODEL,
		undefined,
		{ ...DEFAULT_SETTINGS, imageGeneration: false },
	);
	const body = buildRequestBody(
		OPENAI_CODEX_ASTRA_MODEL,
		{ messages: [], tools: [tools[2]!] },
		resolveCodexRequestProfile(settings.requestProfile),
		{
			ownsNativeTool: name => name === "image_generation",
			imageGeneration: settings.imageGenerationImplementation ?? false,
		},
	);
	const additionalTools = body.input[0] as { tools: Array<{ name: string }> };
	assert.deepEqual(additionalTools.tools, []);
	assert.doesNotMatch(JSON.stringify(body), /image_gen|image_generation/);
}));
