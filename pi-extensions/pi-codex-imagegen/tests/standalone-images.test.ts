import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { standaloneImageGeneration } from "@oai404iao/pi-codex-imagegen/internal/tools/image-generation";
import { loadModelSettings } from "@oai404iao/pi-codex-runtime/internal/model-catalog/runtime";

const originalFetch = globalThis.fetch;
const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
});

function withAgentDir<T>(fn: (agentDir: string) => Promise<T> | T): Promise<T> | T {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-codex-standalone-tools-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const cleanup = () => rmSync(agentDir, { recursive: true, force: true });
	try {
		const result = fn(agentDir);
		return result instanceof Promise ? result.finally(cleanup) : (cleanup(), result);
	} catch (error) {
		cleanup();
		throw error;
	}
}

function jwt(): string {
	const payload = Buffer.from(JSON.stringify({
		"https://api.openai.com/auth": { chatgpt_account_id: "acct_test" },
	})).toString("base64");
	return `header.${payload}.signature`;
}

test("standalone image generation uses the active provider Images endpoint and saves PNG", async () => withAgentDir(async (agentDir) => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-codex-standalone-image-output-"));
	const model = {
		provider: "openai-codex",
		api: "openai-codex-responses",
		id: "gpt-5.6-sol",
		baseUrl: "https://chatgpt.example/backend-api",
		headers: {},
		input: ["text", "image"],
	} as any;
	const base64 = Buffer.from("png-bytes").toString("base64");
	let requestUrl = "";
	let requestBody: any;
	let requestHeaders: Headers | undefined;
	globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
		requestUrl = String(url);
		requestBody = JSON.parse(String(init?.body));
		requestHeaders = new Headers(init?.headers as HeadersInit);
		return Response.json({ created: 1, data: [{ b64_json: base64 }] });
	}) as typeof fetch;
	try {
		const settings = loadModelSettings(model, cwd);
		const result = await standaloneImageGeneration({
			prompt: "A tiny diagram",
			output_format: "webp",
		}, {
			cwd,
			model,
			modelRegistry: {
				async getApiKeyAndHeaders() {
					return { ok: true as const, apiKey: jwt(), headers: {} };
				},
			},
		}, settings, undefined, {
			callId: "call-image",
			turnId: "turn-image",
		});

		assert.equal(requestUrl, "https://chatgpt.example/backend-api/codex/images/generations");
		assert.equal(requestHeaders?.get("x-codex-image-turn-id"), "turn-image");
		assert.deepEqual(requestBody, {
			model: "gpt-image-2",
			prompt: "A tiny diagram",
			background: "auto",
			quality: "auto",
			size: "auto",
		});
		const image = result.content.find((part: any) => part.type === "image") as any;
		assert.equal(image.mimeType, "image/png");
		assert.equal(image.data, base64);
		assert.match((result.details as any).saved.path, /\.png$/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	}
}));

test("standalone image editing can use recent conversation images", async () => withAgentDir(async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-codex-recent-image-output-"));
	const model = {
		provider: "openai-codex",
		api: "openai-codex-responses",
		id: "gpt-5.6-sol",
		baseUrl: "https://chatgpt.example/backend-api",
		headers: {},
		input: ["text", "image"],
	} as any;
	const generated = Buffer.from("generated").toString("base64");
	let requestBody: any;
	let requestHeaders: Headers | undefined;
	globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
		requestBody = JSON.parse(String(init?.body));
		requestHeaders = new Headers(init?.headers as HeadersInit);
		return Response.json({ created: 1, data: [{ b64_json: generated }] });
	}) as typeof fetch;
	const timestamp = new Date().toISOString();
	const imageOne = Buffer.from("one").toString("base64");
	const imageTwo = Buffer.from("two").toString("base64");
	const branch = [
		{
			type: "message",
			id: "user-image",
			parentId: null,
			timestamp,
			message: {
				role: "user",
				content: [{ type: "image", data: imageOne, mimeType: "image/png" }],
				timestamp: Date.now(),
			},
		},
		{
			type: "message",
			id: "tool-image",
			parentId: "user-image",
			timestamp,
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "view_image",
				content: [{ type: "image", data: imageTwo, mimeType: "image/webp" }],
				isError: false,
				timestamp: Date.now(),
			},
		},
	] as any[];
	try {
		await standaloneImageGeneration({
			prompt: "Edit the latest images",
			num_last_images_to_include: 2,
		}, {
			cwd,
			model,
			modelRegistry: {
				async getApiKeyAndHeaders() {
					return { ok: true as const, apiKey: jwt(), headers: {} };
				},
			},
			sessionManager: { getBranch: () => branch },
		}, loadModelSettings(model, cwd), undefined, {
			callId: "call-image",
			turnId: "turn-image",
		});

		assert.deepEqual(requestBody.images, [
			{ image_url: `data:image/png;base64,${imageOne}` },
			{ image_url: `data:image/webp;base64,${imageTwo}` },
		]);
		assert.equal(requestHeaders?.get("x-codex-image-turn-id"), "turn-image");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}));
