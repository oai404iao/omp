import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderAgentCall, renderAgentMessage, renderAgentResult } from "../src/render.ts";
import { truncateUtf8 } from "../src/result.ts";

const theme = { fg: (_color: unknown, text: string) => text, bold: (text: string) => text } as Theme;

test("tool/message rendering handles narrow widths, Unicode, partial results and collapsed bodies", () => {
	const call = renderAgentCall("spawn_agent", { task_name: "review", message: "审查结果 ".repeat(100) }, theme);
	for (const line of call.render(24)) assert(visibleWidth(line) <= 24);
	assert.match(renderAgentResult([{ type: "text", text: '{"task_name":"/root/review"}' }], false, theme).render(80).join("\n"), /Started \/root\/review/);
	assert.doesNotThrow(() => renderAgentResult([{ type: "text", text: '{"partial"' }], false, theme).render(20));
	const body = Array.from({ length: 20 }, (_, n) => `line ${n}`).join("\n");
	assert.doesNotMatch(renderAgentMessage(body, false, theme).render(80).join("\n"), /line 19/);
	assert.match(renderAgentMessage(body, true, theme).render(80).join("\n"), /line 19/);
	const clipped = truncateUtf8("中文🙂", 7);
	assert.equal(clipped.text, "中文");
	assert.equal(clipped.omittedBytes, 4);
});
