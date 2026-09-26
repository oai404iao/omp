import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWebSearchToolDefinition } from "@oai404iao/pi-codex-web-search/internal/tools/web-search";

test("web_search definition exposes Codex commands and preserves hosted execution", async () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const agentDir = mkdtempSync(join(tmpdir(), "pi-web-search-renderer-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const tool = createWebSearchToolDefinition() as Record<string, any>;
		assert.equal(tool.name, "web_search");
		assert.equal(tool.parameters.type, "object");
		assert.equal(tool.parameters.additionalProperties, false);
		assert.ok(tool.parameters.properties.search_query);
		assert.ok(tool.parameters.properties.image_query);
		assert.ok(tool.parameters.properties.open);
		assert.equal(typeof tool.renderCall, "function");
		assert.equal(typeof tool.renderResult, "function");
		const theme = {
			fg(_color: string, text: string) { return text; },
			bold(text: string) { return text; },
		};
		const call = tool.renderCall(
			{ search_query: [{ q: "codex tools" }] },
			theme,
			{ cwd: process.cwd() },
		).render(120).join("\n");
		assert.match(call, /Web Search codex tools/);
		const rendered = tool.renderResult({
			content: [{ type: "text", text: "raw search payload" }],
			details: {
				mode: "standalone",
				results: [
					{ domain: "www.github.com", url: "https://github.com/openai/codex" },
					{ url: "https://openai.com/codex" },
					{ domain: "github.com", url: "https://github.com/openai" },
				],
			},
		}, { expanded: false }, theme, { cwd: process.cwd(), isError: false }).render(120).join("\n");
		assert.match(rendered, /\(3\)/);
		assert.match(rendered, /github\.com/);
		assert.match(rendered, /openai\.com/);
		assert.doesNotMatch(rendered, /raw search payload/);
		const expanded = tool.renderResult({
			content: [{ type: "text", text: "raw search payload" }],
			details: { mode: "standalone", results: [] },
		}, { expanded: true }, theme, { cwd: process.cwd(), isError: false }).render(120).join("\n");
		assert.match(expanded, /raw search payload/);
		const result = await tool.execute("", {}, undefined, undefined, {
			cwd: process.cwd(),
			model: {
				provider: "openai",
				api: "openai-responses",
				id: "gpt-5.5",
				input: ["text"],
			},
		});
		assert.match(result.content[0].text, /hosted-provider-first/);
		assert.equal(result.details.nativeTool, "web_search");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	}
});
