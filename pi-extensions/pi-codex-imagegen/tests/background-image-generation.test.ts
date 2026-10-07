import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseImageGenCommandArgs, selectCodexImageModel } from "@oai404iao/pi-codex-imagegen/internal/background-image-generation";

function withAgentDir<T>(fn: () => T): T {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const agentDir = mkdtempSync(join(tmpdir(), "pi-codex-background-image-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		return fn();
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	}
}

test("parseImageGenCommandArgs separates @reference images from prompt", () => {
	assert.deepEqual(parseImageGenCommandArgs("make it green @icon.png 'with soft shadows' @refs/logo.webp"), {
		prompt: "make it green with soft shadows",
		imagePaths: ["icon.png", "refs/logo.webp"],
	});
});

test("parseImageGenCommandArgs treats pasted image paths as references", () => {
	assert.deepEqual(parseImageGenCommandArgs("make this button green /tmp/pi-clipboard-abc.png"), {
		prompt: "make this button green",
		imagePaths: ["/tmp/pi-clipboard-abc.png"],
	});
	assert.deepEqual(parseImageGenCommandArgs("edit file:///tmp/reference.webp."), {
		prompt: "edit",
		imagePaths: ["/tmp/reference.webp"],
	});
});

test("parseImageGenCommandArgs recognizes GIF and BMP references", () => {
	assert.deepEqual(parseImageGenCommandArgs("edit first.gif second.bmp"), {
		prompt: "edit", imagePaths: ["first.gif", "second.bmp"],
	});
});

test("selectCodexImageModel prefers current catalog-capable model and registry fallback", () => withAgentDir(() => {
	const current = { provider: "openai-codex", id: "gpt-5.4", input: ["text", "image"] };
	assert.equal(selectCodexImageModel(current, undefined), current);
	const fallback = { provider: "openai-codex", id: "gpt-5.5", input: ["text", "image"] };
	assert.equal(selectCodexImageModel({ provider: "anthropic", id: "claude", input: ["text", "image"] }, { getAll: () => [fallback] }), fallback);
	assert.equal(selectCodexImageModel({ provider: "anthropic", id: "claude", input: ["text", "image"] }, { getAvailable: () => [fallback] }), fallback);
	assert.equal(selectCodexImageModel({ provider: "openai-codex", id: "text-only", input: ["text"] }, { find: (_provider, _id) => fallback }), fallback);
	assert.equal(selectCodexImageModel({ provider: "openai-codex", id: "text-only", input: ["text"] }, { getAll: () => [{ provider: "openai-codex", id: "also-text-only", input: ["text"] }] }), undefined);
}));

test("removed hosted configuration fails rather than silently selecting a different model", () => withAgentDir(() => {
	const directory = join(process.env.PI_CODING_AGENT_DIR!, "extensions", "pi-codex-minimal-tools");
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "models.json"), JSON.stringify({
		version: 1, models: [
			{ id: "openai/gpt-5.6-sol", tools: { imageGeneration: "hosted" } },
			{ id: "custom/child", extends: "openai/gpt-5.6-sol" },
			{ id: "custom/grandchild", extends: "custom/child" },
			{ id: "custom/fixed", extends: "custom/grandchild", tools: { imageGeneration: "standalone" } },
		],
	}));
	const fallback = { provider: "openai-codex", id: "gpt-5.5", input: ["text", "image"] };
	assert.throws(() => selectCodexImageModel({
		provider: "openai", id: "gpt-5.6-sol", input: ["text", "image"],
	}, { getAll: () => [fallback] }), /Hosted image generation was removed.*no alternate model/);
	for (const id of ["child", "grandchild"]) {
		assert.throws(() => selectCodexImageModel({ provider: "custom", id, input: ["text", "image"] },
			{ getAll: () => [fallback] }), /Hosted image generation was removed.*no alternate model/);
	}
	const fixed = { provider: "custom", id: "fixed", input: ["text", "image"] };
	assert.equal(selectCodexImageModel(fixed, { getAll: () => [fallback] }), fixed);
	assert.equal(selectCodexImageModel(fallback, { getAll: () => [] }), fallback);
}));
