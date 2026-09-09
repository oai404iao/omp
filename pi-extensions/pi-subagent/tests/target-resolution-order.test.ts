import assert from "node:assert/strict";
import { test } from "node:test";
import type { SubagentCoordinator } from "../src/coordinator.ts";
import { withTargetResolutionOrder } from "./support/target-resolution-order.ts";

for (const failure of ["lookup", "request"] as const) {
	test(`target-order fixture drains blocked requests and restores lookup after ${failure} failure`, async (t) => {
		const error = new Error("fixture failure");
		const subject = {
			async resolveTarget(index: number) {
				if (index === 1) throw error;
				return index;
			},
		};
		const original = subject.resolveTarget;
		let firstCompleted = false;
		await assert.rejects(
			withTargetResolutionOrder(
				t,
				subject as unknown as SubagentCoordinator,
				[1, 0],
				[
					async () => {
						const result = await subject.resolveTarget(0);
						firstCompleted = true;
						return result;
					},
					() => {
						if (failure === "request") throw error;
						return subject.resolveTarget(1);
					},
				],
			),
			(caught) => caught === error,
		);
		assert.equal(firstCompleted, true);
		assert.equal(subject.resolveTarget, original);
		assert.equal(await subject.resolveTarget(0), 0);
	});
}
