import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createImageCapture } from "../src/tools/image-generation/capture.js";
import { createImageDisplay } from "../src/tools/image-generation/display.js";
import { IMAGE_SAVE_DISPLAY_MESSAGE_TYPE, type SavedGeneratedImage } from "../src/tools/image-generation/types.js";
import { captureContext, deferred, withCodexSettings } from "./support/provider-lifecycle-test-support.js";

const saved: SavedGeneratedImage = {
	absolutePath: "/test/image.png", relativePath: "image.png",
	latestAbsolutePath: "/test/latest.png", latestRelativePath: "latest.png",
	responseId: "resp_one", callId: "ig_one", outputFormat: "png",
};
const imageData = { data: "cG5n", mimeType: "image/png" };
const event = {
	type: "response.output_item.done",
	item: { type: "image_generation_call", id: "ig_one", result: imageData.data },
};

function displayHarness() {
	const messages: any[] = [];
	const renderers: Record<string, Function> = {};
	const display = createImageDisplay({
		sendMessage(message, options) { messages.push({ message, options }); },
		registerMessageRenderer(type, renderer) { renderers[type] = renderer; },
	} as Pick<ExtensionAPI, "sendMessage" | "registerMessageRenderer"> as ExtensionAPI);
	return { display, messages, renderers };
}

test("display construction is inert; flush is coalesced, FIFO and non-turn-triggering", t => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const timer = t.mock.method(globalThis, "setTimeout");
	const { display, messages, renderers } = displayHarness();
	assert.equal(timer.mock.callCount(), 0);
	t.mock.timers.tick(0);
	assert.equal(messages.length, 0);
	assert.deepEqual(renderers, {});
	display.registerRenderer();
	assert.equal(typeof renderers[IMAGE_SAVE_DISPLAY_MESSAGE_TYPE], "function");
	const sink = display.captureSink();
	sink(saved, imageData);
	sink({ ...saved, callId: "ig_two" }, imageData);
	display.scheduleFlush();
	display.scheduleFlush();
	assert.equal(messages.length, 0);
	t.mock.timers.tick(0);
	assert.deepEqual(messages.map(entry => entry.message.details.savedImages[0].callId), ["ig_one", "ig_two"]);
	assert.ok(messages.every(entry => entry.options.triggerTurn === false));
	display.flush();
	t.mock.timers.tick(0);
	assert.equal(messages.length, 2);
	display.clear();
});

test("clear cancels pending flushes and invalidates late sinks without affecting another display", t => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const first = displayHarness();
	const second = displayHarness();
	const stale = first.display.captureSink();
	stale(saved, imageData);
	first.display.scheduleFlush();
	first.display.clear();
	first.display.clear();
	stale(saved, imageData);
	first.display.scheduleFlush();
	second.display.captureSink()(saved, imageData);
	second.display.scheduleFlush();
	t.mock.timers.tick(0);
	assert.equal(first.messages.length, 0);
	assert.equal(second.messages.length, 1);
	first.display.captureSink()(saved, imageData);
	first.display.flush();
	assert.equal(first.messages.length, 1);
	first.display.clear();
	second.display.clear();
});

test("a synchronous shutdown flush cancels its timer before a subsequent session queues images", t => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { display, messages } = displayHarness();
	display.captureSink()(saved, imageData);
	display.scheduleFlush();
	display.flush();
	display.clear();
	display.captureSink()({ ...saved, callId: "next_session" }, imageData);
	t.mock.timers.tick(0);
	assert.equal(messages.length, 1, "old timer must not flush the new session");
	display.scheduleFlush();
	t.mock.timers.tick(0);
	assert.equal(messages.length, 2);
	display.clear();
});

test("capture keeps request metadata local, normalizes formats and tolerates persistence failures", async () => {
	await withCodexSettings({}, async directory => {
		const first = captureContext(directory);
		const second = captureContext(directory);
		const calls: any[] = [];
		const published: SavedGeneratedImage[] = [];
		const persist = async (_cwd: string, image: any) => {
			calls.push(image);
			return { ...saved, responseId: image.responseId };
		};
		const a = createImageCapture(first, image => published.push(image), persist);
		const b = createImageCapture(second, image => published.push(image), persist);
		await a({ type: "response.created", response: { id: "resp_a" } });
		await b({ type: "response.created", response: { id: "resp_b" } });
		await Promise.all([a(event), b({ ...event, item: { ...event.item, output_format: "invalid", model: "custom-image" } })]);
		assert.deepEqual(published.map(image => image.responseId), ["resp_a", "resp_b"]);
		assert.ok(calls.every(image => image.outputFormat === "png" && image.revisedPrompt === "request prompt"));
		assert.equal(calls[1].imageModel, "custom-image");
		let failedNotifications = 0;
		const failed = createImageCapture(first, () => { failedNotifications++; }, async () => { throw new Error("disk full"); });
		await failed(event);
		assert.equal(failedNotifications, 0);
	});
});

test("abort and session replacement suppress late capture notifications", async () => {
	await withCodexSettings({}, async directory => {
		const controller = new AbortController();
		const persisted = deferred<SavedGeneratedImage>();
		const { display, messages } = displayHarness();
		let writes = 0;
		const capture = createImageCapture(captureContext(directory, controller.signal), display.captureSink(), async () => {
			writes++;
			return persisted.promise;
		});
		const pending = capture(event);
		controller.abort();
		display.clear();
		persisted.resolve(saved);
		await pending;
		await capture(event);
		display.flush();
		assert.equal(writes, 1, "abort must not begin another write");
		assert.equal(messages.length, 0);

		const late = deferred<SavedGeneratedImage>();
		const oldCapture = createImageCapture(captureContext(directory), display.captureSink(), () => late.promise);
		const oldRequest = oldCapture(event);
		display.clear();
		late.resolve(saved);
		await oldRequest;
		display.flush();
		assert.equal(messages.length, 0, "replacement must invalidate the request's captured sink even without abort");
	});
});
