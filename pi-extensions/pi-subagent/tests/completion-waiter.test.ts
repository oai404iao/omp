import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import { SubagentCoordinator } from "../src/coordinator.ts";

interface Waiter {
	promise: Promise<"activity" | "timeout">;
	wake(): void;
	reject(error: Error): void;
	dispose(): void;
}

const coordinator = SubagentCoordinator.prototype as unknown as {
	createCompletionWaiter(timeoutMs: number, signal: AbortSignal): Waiter;
};

test("an awaited completion timeout keeps the event loop alive", async (t) => {
	const timers = t.mock.method(globalThis, "setTimeout");
	const controller = new AbortController();
	const waiter = coordinator.createCompletionWaiter(10, controller.signal);
	try {
		const timer = timers.mock.calls[0]!.result as ReturnType<typeof setTimeout>;
		assert.equal(timer.hasRef(), true, "wait_agent is foreground work, not a speculative timer");
		assert.equal(await waiter.promise, "timeout");
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	} finally {
		waiter.dispose();
	}
});

for (const finish of ["wake", "abort", "reject", "dispose"] as const) {
	test(`completion ${finish} releases its timer and abort subscription`, async (t) => {
		const timers = t.mock.method(globalThis, "setTimeout");
		const clear = t.mock.method(globalThis, "clearTimeout");
		const controller = new AbortController();
		const waiter = coordinator.createCompletionWaiter(120_000, controller.signal);
		const timer = timers.mock.calls[0]!.result;
		const reason = new Error("finished");
		try {
			const outcome = waiter.promise.then(value => value, error => error);
			if (finish === "abort") controller.abort(reason);
			else if (finish === "reject") waiter.reject(reason);
			else waiter[finish]();
			assert.ok(clear.mock.calls.some(call => call.arguments[0] === timer));
			assert.equal(getEventListeners(controller.signal, "abort").length, 0);
			if (finish !== "dispose") {
				assert.equal(await outcome, finish === "wake" ? "activity" : reason);
			}
		} finally {
			waiter.dispose();
		}
	});
}
