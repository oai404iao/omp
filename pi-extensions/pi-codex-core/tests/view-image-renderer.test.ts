import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { getCapabilities, setCapabilities, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import codexCore from "../src/index.js";
import { withCodexSettings } from "../../../tests/codex/support/provider-lifecycle-test-support.js";

test("view_image self rendering pads call, result headers and image fallback without changing exposure", () =>
	withCodexSettings({}, async () => {
		const tools: Record<string, any> = {};
		codexCore({
			events: createEventBus(), on() {}, registerProvider() {}, registerCommand() {},
			registerTool(tool: any) { tools[tool.name] = tool; },
		} as any);
		const tool = tools.view_image;
		assert.equal(tool.exposure, "model-only");
		assert.equal(tool.renderShell, "self");
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
		const capabilities = getCapabilities();
		setCapabilities({ ...capabilities, images: null });
		try {
			const details = { displayPath: "sample.png", mimeType: "image/png", sizeBytes: 10 };
			const result = { details, content: [{ type: "image", mimeType: "image/png", data: "fixture" }] };
			for (const image of [false, true]) {
				const unpadded = tool.renderResult(image ? result : { details }, {}, theme, { outputPad: 0 })
					.render(120).map((line: string) => stripTerminalSequences(line).trimEnd());
				assert(unpadded.length >= (image ? 2 : 1));
				for (const outputPad of [0, 1]) {
					const lines = tool.renderResult(image ? result : { details }, {}, theme, { outputPad })
						.render(120).map((line: string) => stripTerminalSequences(line).trimEnd());
					assert.deepEqual(lines, unpadded.map((line: string) => " ".repeat(outputPad) + line));
					assert(lines.every((line: string) => visibleWidth(line) <= 120));
				}
			}
			for (const outputPad of [0, 1]) {
				const unpadded = tool.renderCall({ path: "sample.png" }, theme, { outputPad: 0 }).render(120)[0].trimEnd();
				assert.equal(tool.renderCall({ path: "sample.png" }, theme, { outputPad }).render(120)[0].trimEnd(),
					" ".repeat(outputPad) + unpadded);
				assert.deepEqual(tool.renderCall({}, theme, { outputPad, executionStarted: true }).render(120), []);
				assert.deepEqual(tool.renderResult(result, { isPartial: true }, theme, { outputPad }).render(120), []);
			}
		} finally { setCapabilities(capabilities); }
	}));
