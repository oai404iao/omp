import assert from "node:assert/strict";
import { test } from "node:test";
import {
	AgentOperationQueue,
	BackgroundConcurrencyLimitError,
	BackgroundRunLimiter,
} from "../src/scheduler.ts";

test("background limiter grants queued permits in FIFO order", async () => {
	const limiter = new BackgroundRunLimiter(1);
	const first = await limiter.acquire();
	const order: string[] = [];
	const secondPromise = limiter.acquire().then((permit) => {
		order.push("second");
		return permit;
	});
	const thirdPromise = limiter.acquire().then((permit) => {
		order.push("third");
		return permit;
	});
	assert.equal(limiter.activeCount, 1);
	assert.equal(limiter.pendingCount, 2);

	first.release();
	const second = await secondPromise;
	assert.deepEqual(order, ["second"]);
	second.release();
	const third = await thirdPromise;
	assert.deepEqual(order, ["second", "third"]);
	third.release();
	assert.equal(limiter.activeCount, 0);
});

test("nested background work can fail instead of deadlocking at capacity", async () => {
	const limiter = new BackgroundRunLimiter(1);
	const permit = await limiter.acquire();
	await assert.rejects(
		() => limiter.acquire({ waitForCapacity: false }),
		(error: unknown) =>
			error instanceof BackgroundConcurrencyLimitError &&
			error.limit === 1,
	);
	permit.release();
});

test("background limit adjusts safely around active runs", async () => {
	const limiter = new BackgroundRunLimiter(2);
	const first = await limiter.acquire();
	const second = await limiter.acquire();
	limiter.configure(1);
	const queued = limiter.acquire();
	first.release();
	assert.equal(limiter.activeCount, 1);
	assert.equal(limiter.pendingCount, 1);
	second.release();
	const afterReduction = await queued;
	assert.equal(limiter.activeCount, 1);
	afterReduction.release();

	limiter.configure(4);
	const permits = await Promise.all([
		limiter.acquire(),
		limiter.acquire(),
		limiter.acquire(),
		limiter.acquire(),
	]);
	assert.equal(limiter.activeCount, 4);
	for (const current of permits) current.release();
});

test("queued background acquisition follows abort and shutdown", async () => {
	const limiter = new BackgroundRunLimiter(1);
	const permit = await limiter.acquire();
	const controller = new AbortController();
	const aborted = limiter.acquire({ signal: controller.signal });
	controller.abort(new Error("cancel queued run"));
	await assert.rejects(aborted, /cancel queued run/);

	const closing = limiter.acquire();
	limiter.close(new Error("scheduler closed"));
	await assert.rejects(closing, /scheduler closed/);
	permit.release();
});

test("agent operation queue serializes one agent without blocking another", async () => {
	const operations = new AgentOperationQueue();
	const order: string[] = [];
	let releaseFirst!: () => void;
	const firstGate = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	const first = operations.run("same", async () => {
		order.push("first:start");
		await firstGate;
		order.push("first:end");
	});
	const second = operations.run("same", async () => {
		order.push("second");
	});
	const other = operations.run("other", async () => {
		order.push("other");
	});

	await other;
	assert.deepEqual(order, ["first:start", "other"]);
	releaseFirst();
	await Promise.all([first, second]);
	assert.deepEqual(order, ["first:start", "other", "first:end", "second"]);
});
