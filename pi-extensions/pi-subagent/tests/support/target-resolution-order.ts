import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { SubagentCoordinator } from "../../src/coordinator.ts";

type TargetResolver = {
	resolveTarget(...args: unknown[]): Promise<unknown>;
};

function gate(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
	return { promise, resolve };
}

export async function withTargetResolutionOrder<T>(
	test: TestContext,
	coordinator: SubagentCoordinator,
	order: readonly [0 | 1, 0 | 1],
	requests: readonly [() => Promise<T>, () => Promise<T>],
): Promise<[T, T]> {
	assert.notEqual(order[0], order[1]);
	const resolver = coordinator as unknown as TargetResolver;
	const original = resolver.resolveTarget;
	const arrived = [gate(), gate()];
	const gates = [gate(), gate()];
	let calls = 0;
	// Target lookup precedes the durable-id queue. Hold real lookup results, not
	// mailbox writes, so both requests contend for the unchanged operation queue.
	const lookup = test.mock.method(resolver, "resolveTarget", async function (...args: unknown[]) {
		const index = calls++;
		const target = await original.apply(coordinator, args);
		assert.ok(index < gates.length, "unexpected additional target lookup");
		arrived[index]!.resolve();
		await gates[index]!.promise;
		return target;
	});
	const pending = [
		Promise.resolve().then(requests[0]),
		Promise.resolve().then(requests[1]),
	] as const;
	const deliveries = Promise.all(pending);
	try {
		// Also observe delivery failures here rather than waiting forever for a
		// failed lookup to signal arrival.
		await Promise.race([Promise.all(arrived.map(gate => gate.promise)), deliveries]);
		assert.equal(calls, 2);
		gates[order[0]]!.resolve();
		gates[order[1]]!.resolve();
		return await deliveries;
	} finally {
		for (const gate of gates) gate.resolve();
		await Promise.allSettled(pending);
		lookup.mock.restore();
	}
}
