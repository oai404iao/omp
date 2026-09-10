import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createImageGenerationToolDefinition, directImageGeneration } from "../src/tools/image-generation.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-image-generation-"));
}

test("directImageGeneration omits deprecated response_format and passes abort signal", async () => {
	const previousKey = process.env.OPENAI_API_KEY;
	const previousFetch = globalThis.fetch;
	const controller = new AbortController();
	let body: any;
	let seenSignal: AbortSignal | undefined;
	process.env.OPENAI_API_KEY = "test";
	globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
		body = JSON.parse(String(init?.body));
		seenSignal = init?.signal ?? undefined;
		return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("png").toString("base64") }] }), { status: 200, headers: { "content-type": "application/json" } });
	}) as typeof fetch;
	try {
		await directImageGeneration({ prompt: "test" }, tempDir(), { ...DEFAULT_SETTINGS, directImageApiFallback: true }, controller.signal);
		assert.equal("response_format" in body, false);
		assert.equal(seenSignal, controller.signal);
	} finally {
		if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = previousKey;
		globalThis.fetch = previousFetch;
	}
});

test("global image gate blocks direct fallback before authentication or network I/O", async () => {
	const previousFetch = globalThis.fetch;
	let fetched = false;
	globalThis.fetch = (async () => {
		fetched = true;
		throw new Error("must not fetch");
	}) as typeof fetch;
	try {
		await assert.rejects(
			directImageGeneration(
				{ prompt: "test" },
				tempDir(),
				{
					...DEFAULT_SETTINGS,
					imageGeneration: false,
					directImageApiFallback: true,
				},
			),
			/global imageGeneration setting/,
		);
		assert.equal(fetched, false);
	} finally {
		globalThis.fetch = previousFetch;
	}
});

test("per-model image gate blocks manual execution before fallback or auth", async () => {
	let authRequested = false;
	const tool = createImageGenerationToolDefinition({
		loadSettings: () => ({
			...DEFAULT_SETTINGS,
			directImageApiFallback: true,
		}),
		hasProviderRuntime: () => true,
	});
	await assert.rejects(
		tool.execute(
			"image-disabled",
			{ prompt: "test" },
			undefined,
			undefined,
			{
				cwd: tempDir(),
				model: {
					provider: "openai",
					id: "o4-mini",
					api: "openai-responses",
					input: ["text", "image"],
				} as any,
				modelRegistry: {
					async getApiKeyAndHeaders() {
						authRequested = true;
						return { ok: true, apiKey: "must-not-be-used" };
					},
				},
			},
		),
		/global setting or current model profile/,
	);
	assert.equal(authRequested, false);
});
