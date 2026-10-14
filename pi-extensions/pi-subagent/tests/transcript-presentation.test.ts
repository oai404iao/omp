import assert from "node:assert/strict";
import { test } from "node:test";
import { Text } from "@earendil-works/pi-tui";
import type { AgentSession, MarkdownTransformer, MessageRenderer, Theme, ToolDefinition, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { createTranscriptPresentation } from "../src/transcript-presentation.ts";
import { MESSAGE_CUSTOM_TYPE } from "../src/store.ts";

type CallContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
const context = (): CallContext => ({
	args: {}, toolCallId: "call", invalidate() {}, state: {}, cwd: "/workspace", lastComponent: undefined, durationMs: undefined,
	executionStarted: false, argsComplete: true, isPartial: false, expanded: false, showImages: false, isError: false, outputPad: 1,
});
const theme = { fg: (_color: unknown, text: string) => text, bg: (_color: unknown, text: string) => text, bold: (text: string) => text } as Theme;

function fixture() {
	const definitions = new Map<string, ToolDefinition>();
	const messages = new Map<string, MessageRenderer>();
	let transforms: MarkdownTransformer[] = [];
	let override: ToolRenderers | undefined;
	let outputPad: 0 | 1 = 0;
	let resolutions = 0;
	const session = {
		settingsManager: { getOutputPad: () => outputPad },
		getToolDefinition: (name: string) => definitions.get(name),
		extensionRunner: {
			resolveToolRenderers(_name: string, base: () => ToolRenderers | undefined) {
				resolutions++;
				return override ?? base();
			},
			getMessageRenderer: (name: string) => messages.get(name),
			getMarkdownTransformers: () => transforms,
		},
	} as unknown as AgentSession;
	return {
		session, definitions, messages,
		override(value: ToolRenderers) { override = value; },
		transformers(value: MarkdownTransformer[]) { transforms = value; },
		padding(value: 0 | 1) { outputPad = value; },
		get resolutions() { return resolutions; },
	};
}

test("presentation uses registered/resolved renderers before native fallback, without executing definitions", () => {
	const f = fixture();
	const fallback: ToolRenderers = {
		renderCall: () => new Text("native call"), renderResult: () => new Text("native result"),
	};
	f.definitions.set("bash", {
		name: "bash", description: "", parameters: { type: "object" },
		execute() { throw new Error("Must never execute"); },
		renderCall: () => new Text("registered call"),
	} as unknown as ToolDefinition);
	const presentation = createTranscriptPresentation("/workspace", f.session);
	assert.equal(presentation.outputPad, 0);
	const renderer = presentation.resolveTool("bash", fallback)!;
	assert.equal(renderer.renderCall!({}, theme, context()).render(80).join("").trim(), "registered call");
	assert.equal(renderer.renderResult!({ content: [], details: undefined }, { expanded: false, isPartial: false }, theme, context()).render(80).join("").trim(), "native result");
	f.override({ renderShell: "self", renderCall: () => new Text("resolver override") });
	assert.equal(renderer.renderCall!({}, theme, context()).render(80).join("").trim(), "resolver override",
		"callbacks re-resolve rather than retaining extension callbacks");
	assert(f.resolutions >= 4);
	assert.equal(presentation.resolveTool("unknown")?.renderCall!({}, theme, context()).render(80).join("").trim(), "resolver override");
});

test("presentation revisions are session-specific; cold mode never loads a runtime or custom tools", () => {
	const a = fixture();
	const b = fixture();
	const first = createTranscriptPresentation("/a", a.session);
	assert.equal(createTranscriptPresentation("/a", a.session).revision, first.revision);
	assert.notEqual(createTranscriptPresentation("/a", b.session).revision, first.revision);
	a.padding(1);
	assert.equal(createTranscriptPresentation("/a", a.session).outputPad, 1);
	const cold = createTranscriptPresentation("/b");
	assert.equal(cold.revision, "cold");
	assert.equal(cold.outputPad, 1);
	assert.equal(cold.cwd, "/b");
	const fallback = { renderCall: () => new Text("native") };
	assert.equal(cold.resolveTool("read", fallback)?.renderCall!({}, theme, context()).render(80).join("").trim(), "native");
	assert.equal(cold.resolveTool("unregistered"), undefined);
});

test("native custom message and Markdown resolver callbacks follow current session registrations", () => {
	const f = fixture();
	f.messages.set("custom", () => new Text("first renderer"));
	f.transformers([markdown => `${markdown} first`]);
	const presentation = createTranscriptPresentation("/workspace", f.session);
	const message = { role: "custom" as const, customType: "custom", content: "text", display: true, timestamp: 1 };
	const renderer = presentation.resolveMessage("custom")!;
	assert.equal(renderer(message, { expanded: false, outputPad: 0 }, theme)?.render(80).join("").trim(), "first renderer");
	f.messages.set("custom", () => new Text("second renderer"));
	assert.equal(renderer(message, { expanded: false, outputPad: 0 }, theme)?.render(80).join("").trim(), "second renderer");
	const markdownContext = { messageType: "assistant" as const, isStreaming: false, availableWidth: 80 };
	assert.equal(presentation.markdownTransformers[0]("markdown", markdownContext), "markdown first");
	f.transformers([]);
	assert.equal(presentation.markdownTransformers[0]("markdown", markdownContext), "markdown");
	f.messages.delete("custom");
	assert.equal(renderer(message, { expanded: false, outputPad: 0 }, theme), undefined);
});

test("cold attribution messages reuse the extension's existing main-session renderer", () => {
	const presentation = createTranscriptPresentation("/workspace");
	const renderer = presentation.resolveMessage(MESSAGE_CUSTOM_TYPE);
	assert(renderer);
	const component = renderer({
		role: "custom", customType: MESSAGE_CUSTOM_TYPE, content: "[Agent task: /root/worker]\nReview safely.",
		display: true, timestamp: 1,
	}, { expanded: true, outputPad: 1 }, theme)!;
	assert.match(component.render(90).join("\n"), /Review safely/);
	assert.equal(presentation.resolveMessage("unknown"), undefined);
});
