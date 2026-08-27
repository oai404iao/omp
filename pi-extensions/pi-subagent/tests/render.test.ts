import assert from "node:assert/strict";
import test from "node:test";
import { renderDelegationResult } from "../src/render.ts";
import type { DelegationDetails } from "../src/types.ts";

const theme = {
	fg: (_color: unknown, text: string) => text,
	bold: (text: string) => text,
};

test("delegation renderer accepts pre-path historical details", () => {
	const legacy = {
		kind: "delegation",
		agentId: "01900000-0000-7000-8000-000000000000",
		provider: "fork",
		mode: "one-shot",
		agent: "scout",
		label: "legacy row",
		depth: 1,
		status: "completed",
		trace: [],
	} as unknown as DelegationDetails;
	assert.doesNotThrow(() =>
		renderDelegationResult(
			legacy,
			"legacy output",
			{ expanded: false, isPartial: false },
			theme,
		),
	);
});
