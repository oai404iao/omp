import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createBackgroundImageJobs } from "@oai404iao/pi-codex-imagegen/internal/background-image-jobs";
import { registerBackgroundImageGenerationCommand } from "@oai404iao/pi-codex-imagegen/internal/background-image-generation";
import { standaloneImageGeneration } from "@oai404iao/pi-codex-imagegen/internal/tools/image-generation";
import { loadModelSettings } from "@oai404iao/pi-codex-runtime/internal/model-catalog/runtime";
import { compositionModel, createCompositionHost, withCompositionDirectory, writeCompositionConfig } from "../../../tests/codex/support/composition-host.js";
import { clearEndpointFailures, watchEndpointFailures } from "@oai404iao/pi-codex-runtime/internal/endpoint-state";

function gate<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => { resolve = done; });
	return { promise, resolve };
}

const auth = { ok: true, apiKey: "fixture", headers: {} };
const drain = () => new Promise<void>(done => setImmediate(done));
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6pAAAAABJRU5ErkJggg==";

for (const denyByConfig of [false, true]) test(`background standalone denial never falls through to hosted (config=${denyByConfig})`, t =>
	withCompositionDirectory(async directory => {
		const host = createCompositionHost(directory);
		const sessionId = host.ctx.sessionManager.getSessionId();
		const notices: string[] = [];
		const stop = watchEndpointFailures(sessionId, message => { if (message) notices.push(message); });
		let finished = gate<void>();
		host.ctx.ui = { ...ui([]), setStatus(_key: string, value?: string) { if (value === undefined) finished.resolve(); } };
		host.ctx.modelRegistry.getApiKeyAndHeaders = async () => auth;
		if (denyByConfig) writeCompositionConfig(directory, { endpoint_config: [{
			provider: host.ctx.model.provider, baseUrl: host.ctx.model.baseUrl, imageGeneration: [],
		}] });
		let requests = 0;
		t.mock.method(globalThis, "fetch", async (...[url]: Parameters<typeof fetch>) => {
			requests++;
			assert.match(String(url), /images\/generations$/);
			return Response.json({ error: { code: "unsupported_endpoint", message: "images/generations is unsupported" } }, { status: 400 });
		});
		registerBackgroundImageGenerationCommand(host.api());
		try {
			for (let index = 0; index < 2; index++) {
				finished = gate<void>();
				await host.commands.get("image-gen").handler("fixture", host.ctx);
				await finished.promise;
			}
			assert.equal(requests, denyByConfig ? 0 : 1);
			assert.equal(notices.length, denyByConfig ? 0 : 1);
		} finally {
			stop(); clearEndpointFailures(sessionId);
			await host.emit("session_shutdown"); host.dispose();
		}
	}));

function ui(calls: unknown[]) {
	return {
		setStatus: (...args: unknown[]) => { calls.push(args); },
		setWidget: (...args: unknown[]) => { calls.push(args); },
		notify: (...args: unknown[]) => { calls.push(args); },
	};
}

test("background jobs are instance-local and reset invalidates late finishes", (t) => {
	const intervals = t.mock.method(globalThis, "setInterval");
	const clear = t.mock.method(globalThis, "clearInterval");
	const first = createBackgroundImageJobs();
	const second = createBackgroundImageJobs();
	const calls: unknown[] = [];
	const ctx = { ui: ui(calls) } as any;
	const a = first.start(ctx, { prompt: "first", imagePaths: [] }, "fixture");
	const b = second.start(ctx, { prompt: "second", imagePaths: [] }, "fixture");
	try {
		first.reset(ctx);
		assert.equal(a.signal.aborted, true);
		assert.equal(b.signal.aborted, false);
		const count = calls.length;
		a.finish();
		assert.equal(calls.length, count);
		b.finish();
		for (const interval of intervals.mock.calls) {
			assert.ok(clear.mock.calls.some(call => call.arguments[0] === interval.result));
		}
	} finally {
		first.reset(ctx);
		second.reset(ctx);
	}
});

for (const id of ["gpt-4.1", "gpt-5.6-sol"]) {
	for (const event of ["session_start", "session_shutdown"]) {
		test(`background ${id} consumes late auth without I/O or UI after ${event}`, (t) =>
			withCompositionDirectory(async directory => {
				const host = createCompositionHost(directory);
				const calls: unknown[] = [];
				const pending = gate<typeof auth>();
				host.ctx.ui = ui(calls);
				host.ctx.model = compositionModel(id);
				host.ctx.modelRegistry.getApiKeyAndHeaders = () => pending.promise;
				const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected I/O"); });
				const api = host.api() as any;
				api.sendMessage = (...args: unknown[]) => { calls.push(args); };
				registerBackgroundImageGenerationCommand(api);
				try {
					await host.commands.get("image-gen").handler("fixture", host.ctx);
					await host.emit(event);
					const count = calls.length;
					pending.resolve(auth);
					await drain();
					assert.equal(fetch.mock.callCount(), 0);
					assert.equal(calls.length, count);
					assert.equal(existsSync(join(directory, ".pi/openai-codex-images")), false);
				} finally {
					pending.resolve(auth);
					await host.emit("session_shutdown");
					host.dispose();
				}
			}));
	}
}

test("standalone ignores a late JSON image result after cancellation", (t) =>
	withCompositionDirectory(async directory => {
		const host = createCompositionHost(directory);
		const controller = new AbortController();
		const jsonStarted = gate<void>();
		const result = gate<{ data: { b64_json: string }[] }>();
		host.ctx.modelRegistry.getApiKeyAndHeaders = async () => auth;
		t.mock.method(globalThis, "fetch", async () => ({
			ok: true,
			status: 200,
			headers: new Headers(),
			json() { jsonStarted.resolve(); return result.promise; },
		}) as Response);
		const pending = standaloneImageGeneration(
			{ prompt: "fixture" }, host.ctx, loadModelSettings(host.ctx.model, directory), controller.signal,
		);
		try {
			const rejected = assert.rejects(pending, /fixture cancellation/);
			await jsonStarted.promise;
			controller.abort(new Error("fixture cancellation"));
			result.resolve({ data: [{ b64_json: png }] });
			await rejected;
			assert.equal(existsSync(join(directory, ".pi/openai-codex-images")), false);
		} finally {
			result.resolve({ data: [{ b64_json: png }] });
			host.dispose();
		}
	}));

test("standalone background shutdown aborts its request and suppresses late errors", (t) =>
	withCompositionDirectory(async directory => {
		const host = createCompositionHost(directory);
		const calls: unknown[] = [];
		host.ctx.ui = ui(calls);
		host.ctx.model = compositionModel("gpt-4.1");
		host.ctx.modelRegistry.getApiKeyAndHeaders = async () => auth;
		const reading = gate<void>();
		const result = gate<Response>();
		let signal: AbortSignal | undefined;
		t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof fetch>) => {
			signal = init?.signal as AbortSignal;
			reading.resolve();
			return result.promise;
		});
		const api = host.api() as any;
		api.sendMessage = (...args: unknown[]) => { calls.push(args); };
		registerBackgroundImageGenerationCommand(api);
		try {
			await host.commands.get("image-gen").handler("fixture", host.ctx);
			await reading.promise;
			await host.emit("session_shutdown");
			assert.equal(signal?.aborted, true);
			const count = calls.length;
			result.resolve(Response.json({ data: [{ b64_json: png }] }));
			await drain();
			assert.equal(calls.length, count);
		} finally {
			result.resolve(Response.json({ data: [{ b64_json: png }] }));
			await host.emit("session_shutdown");
			host.dispose();
		}
	}));

for (const id of ["gpt-4.1", "gpt-5.6-sol"]) test(`background ${id} uses resolved auth/base URL, notifies once and clears status`, (t) =>
	withCompositionDirectory(async directory => {
		const host = createCompositionHost(directory);
		host.ctx.model = compositionModel(id);
		const finished = gate<void>();
		host.ctx.ui = {
			...ui([]),
			setStatus(_key: string, value?: string) { if (value === undefined) finished.resolve(); },
		};
		host.ctx.modelRegistry.getApiKeyAndHeaders = async () => ({
			...auth, baseUrl: "https://resolved.invalid/v2",
			headers: { authorization: null, "x-api-key": "resolved" },
		});
		t.mock.method(globalThis, "fetch", async (...[url, init]: Parameters<typeof fetch>) => {
			assert.equal(String(url), "https://resolved.invalid/v2/images/generations");
			assert.equal(new Headers(init?.headers).get("authorization"), null);
			assert.equal(new Headers(init?.headers).get("x-api-key"), "resolved");
			return Response.json({ data: [{ b64_json: png }] });
		});
		registerBackgroundImageGenerationCommand(host.api());
		try {
			await host.commands.get("image-gen").handler("fixture", host.ctx);
			await finished.promise;
			assert.equal(host.messages.length, 1);
			assert.equal(existsSync(host.messages[0].details.savedImages[0].absolutePath), true);
		} finally {
			await host.emit("session_shutdown");
			host.dispose();
		}
	}));
