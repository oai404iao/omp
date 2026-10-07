import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PhotonImage } from "@silvia-odwyer/photon-node";
import { beginCodexTurn, endCodexTurn, resetCodexWireState } from "@oai404iao/pi-codex-runtime/internal/codex-wire-identity";
import { loadModelSettings } from "@oai404iao/pi-codex-runtime/internal/model-catalog/runtime";
import { IMAGE_GENERATION_NAMESPACE } from "@oai404iao/pi-codex-runtime/internal/reserved-tools/image-generation";
import { imageGenerationToolSchema, standaloneImageGeneration } from "@oai404iao/pi-codex-imagegen/internal/tools/image-generation";
import { deferred, withCodexSettings } from "../../../tests/codex/support/provider-lifecycle-test-support.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6pAAAAABJRU5ErkJggg==";
const model = { provider: "openai", api: "openai-responses", id: "gpt-5.6-sol", baseUrl: "https://fixture.invalid/v1" } as any;
const auth = { ok: true as const, apiKey: "fixture" };

test("image schemas expose the pinned boolean background choice", () => {
	assert.deepEqual(imageGenerationToolSchema.properties.transparent_background, {
		type: "boolean",
		description: "Whether the output should have a transparent background. Defaults to false.",
	});
	const tool = IMAGE_GENERATION_NAMESPACE.tools[0];
	assert.match(tool.description, /Set `transparent_background` to true/);
	assert.deepEqual((tool.parameters as any).properties.transparent_background, imageGenerationToolSchema.properties.transparent_background);
});

for (const value of [undefined, false, true]) test(`image request background ${value} uses pinned JSON defaults`, t =>
	withCodexSettings({}, async cwd => {
		t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof fetch>) => {
			assert.deepEqual(JSON.parse(String(init?.body)), {
				model: "gpt-image-2", prompt: " fixture ",
				background: value ? "transparent" : "opaque", quality: "auto", size: "auto",
			});
			assert.equal(init?.method, "POST");
			return Response.json({ data: [{ b64_json: png, generation_id: "generation-fixture" }] }, {
				headers: { "x-codex-imagegen-request-id": "request-fixture" },
			});
		});
		const result = await standaloneImageGeneration({ prompt: " fixture ", transparent_background: value }, {
			cwd, model, modelRegistry: { getApiKeyAndHeaders: async () => auth },
		}, loadModelSettings(model, cwd));
		assert.equal(result.details.requestId, "request-fixture");
		assert.equal(result.details.generationId, "generation-fixture");
	}));

test("standalone snapshots active turn and images before delayed auth and preserves both over retry", t =>
	withCodexSettings({}, async cwd => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: [{ type: "image", data: png, mimeType: "image/png" }], timestamp: 1 });
		const sessionId = sessionManager.getSessionId();
		const initial = beginCodexTurn(sessionId);
		const authGate = deferred<typeof auth>();
		const authStarted = deferred<void>();
		let firstBody = "";
		let requests = 0;
		t.mock.method(globalThis, "fetch", async (...[url, init]: Parameters<typeof fetch>) => {
			requests++;
			assert.equal(String(url), "https://fixture.invalid/v1/images/edits");
			assert.equal(new Headers(init?.headers).get("x-codex-image-turn-id"), initial.turnId);
			const body = String(init?.body);
			if (requests === 1) firstBody = body;
			else assert.equal(body, firstBody);
			assert.deepEqual(JSON.parse(body).images, [{ image_url: `data:image/png;base64,${png}` }]);
			return requests === 1
				? new Response("temporary", { status: 503, headers: { "retry-after-ms": "0" } })
				: Response.json({ data: [{ b64_json: png }] });
		});
		try {
			const pending = standaloneImageGeneration({ prompt: "fixture", num_last_images_to_include: 1 }, {
				cwd, model, sessionManager,
				modelRegistry: { getApiKeyAndHeaders: async () => { authStarted.resolve(); return authGate.promise; } },
			}, loadModelSettings(model, cwd));
			await authStarted.promise;
			endCodexTurn(sessionId);
			beginCodexTurn(sessionId);
			sessionManager.appendMessage({ role: "user", content: [{ type: "image", data: "changed", mimeType: "image/png" }], timestamp: 2 });
			authGate.resolve(auth);
			await pending;
			assert.equal(requests, 2);
		} finally {
			authGate.resolve(auth);
			resetCodexWireState();
		}
	}));

test("reference image content, not extension, determines a usable edit input", t =>
	withCodexSettings({}, async cwd => {
		await writeFile(join(cwd, "extensionless"), Buffer.from(png, "base64"));
		await writeFile(join(cwd, "reference.gif"), Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"));
		// A wide 24-bit BMP must be normalized, not resized to Pi's preview bounds.
		const bmp = Buffer.alloc(54 + 6152);
		bmp.write("BM");
		bmp.writeUInt32LE(bmp.length, 2);
		bmp.writeUInt32LE(54, 10);
		bmp.writeUInt32LE(40, 14);
		bmp.writeInt32LE(2050, 18);
		bmp.writeInt32LE(1, 22);
		bmp.writeUInt16LE(1, 26);
		bmp.writeUInt16LE(24, 28);
		await writeFile(join(cwd, "reference.bmp"), bmp);
		t.mock.method(globalThis, "fetch", async (...[url, init]: Parameters<typeof fetch>) => {
			assert.match(String(url), /images\/edits$/);
			const body = JSON.parse(String(init?.body));
			assert.match(body.images[0].image_url, /^data:image\/png;base64,/);
			for (const [index, width] of [[1, 1], [2, 2050]]) {
				assert.match(body.images[index].image_url, /^data:image\/png;base64,/);
				const decoded = PhotonImage.new_from_byteslice(Buffer.from(body.images[index].image_url.split(",")[1], "base64"));
				try {
					assert.equal(decoded.get_width(), width);
					assert.equal(decoded.get_height(), 1);
					if (index === 1) assert.equal(decoded.get_raw_pixels()[3], 0, "GIF transparency survives PNG normalization");
				} finally {
					decoded.free();
				}
			}
			return Response.json({ data: [{ b64_json: png }] });
		});
		await standaloneImageGeneration({ prompt: "fixture", referenced_image_paths: ["extensionless", "reference.gif", "reference.bmp"] }, {
			cwd, model, modelRegistry: { getApiKeyAndHeaders: async () => auth },
		}, loadModelSettings(model, cwd));
		await writeFile(join(cwd, "fake.png"), "not an image");
		await assert.rejects(standaloneImageGeneration({ prompt: "fixture", referenced_image_paths: ["fake.png"] }, {
			cwd, model, modelRegistry: { getApiKeyAndHeaders: async () => auth },
		}, loadModelSettings(model, cwd)), /Unsupported reference image type/);
	}));

test("nullable optional references mean no edit while invalid count/background fail before auth", t =>
	withCodexSettings({}, async cwd => {
		let authCalls = 0;
		const ctx = { cwd, model, modelRegistry: { getApiKeyAndHeaders: async () => { authCalls++; return auth; } } };
		t.mock.method(globalThis, "fetch", async (...[url]: Parameters<typeof fetch>) => {
			assert.match(String(url), /images\/generations$/);
			return Response.json({ data: [{ b64_json: png }] });
		});
		await standaloneImageGeneration({ prompt: "fixture", referenced_image_paths: null, num_last_images_to_include: null }, ctx, loadModelSettings(model, cwd));
		const count = authCalls;
		await assert.rejects(standaloneImageGeneration({ prompt: "fixture", transparent_background: null } as any, ctx, loadModelSettings(model, cwd)), /must be a boolean/);
		await assert.rejects(standaloneImageGeneration({ prompt: "fixture", num_last_images_to_include: 6 }, {
			...ctx, sessionManager: SessionManager.inMemory(),
		}, loadModelSettings(model, cwd)), /between 1 and 5/);
		assert.equal(authCalls, count);
	}));
