import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, SessionManager, TreeSelectorComponent, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { pickTreeTarget } from "../src/tree-picker.ts";
import { sandbox } from "./fixture.ts";

test("a tree containing only metadata has no pickable instruction and opens no dialog", async t => {
	const sessionManager = SessionManager.inMemory(sandbox(t));
	sessionManager.appendCustomEntry("settings", {});
	const warnings: string[] = [];
	const ctx = { sessionManager, isIdle: () => true, ui: { notify: (_: string, level: string) => warnings.push(level) } };
	assert.equal(await pickTreeTarget(ctx as unknown as ExtensionCommandContext), undefined);
	assert.deepEqual(warnings, ["warning"]);
});

test("the native picker starts on users, rejects non-users, and offers safe, distinct outcome previews", async t => {
	const sessionManager = SessionManager.inMemory(sandbox(t));
	initTheme("dark", false);
	const user = sessionManager.appendMessage({ role: "user", timestamp: 0, content: "which branch" });
	const base = {
		role: "assistant", api: "openai-responses", provider: "openai", model: "fixture", timestamp: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	} as const;
	const emoji = "👩🏽‍💻";
	const answer = sessionManager.appendMessage({ ...base, stopReason: "stop", content: [
		{ type: "text", text: `\x1b[31mfirst\x1b[0m\n\t\x07\u202e\u0085${emoji.repeat(120)}last` },
	] });
	sessionManager.branch(user);
	const error = sessionManager.appendMessage({ ...base, stopReason: "error", content: [], errorMessage: "request failed" });
	sessionManager.branch(user); // The active path has no answer; both older paths are still available.
	const notices: string[] = [];
	const ctx = {
		sessionManager, isIdle: () => true,
		ui: {
			notify: (_: string, level: string) => notices.push(level),
			custom: (factory: (tui: object, theme: undefined, kb: undefined, done: (id: string | undefined) => void) => TreeSelectorComponent) => {
				const picked: (string | undefined)[] = [];
				const selector = factory({ terminal: { rows: 25 } }, undefined, undefined, id => picked.push(id));
				const display = selector.render(100).join("\n");
				assert.match(display, /which branch/);
				assert.doesNotMatch(display, /request failed|first/);
				selector.getTreeList().onSelect!(answer); // A different native filter can reveal this row.
				assert.deepEqual(notices, ["warning"]);
				assert.deepEqual(picked, []);
				selector.handleInput("\r");
				assert.deepEqual(picked, [user]);
				return picked[0];
			},
			select: (_: string, options: string[]) => {
				assert.equal(options.length, 3);
				assert.ok(options.some(label => label.includes(error) && label.includes("request failed")));
				assert.ok(options.some(label => label.includes("无最终回复")));
				const label = options.find(label => label.includes(answer));
				assert.ok(label);
				assert.match(label, /first (?:👩🏽‍💻)+…$/u);
				assert.doesNotMatch(label, /[\p{Cc}\p{Bidi_Control}]/u);
				return label;
			},
		},
	};
	assert.deepEqual(await pickTreeTarget(ctx as unknown as ExtensionCommandContext), {
		userMessageEntryId: user, finalAssistantEntryId: answer,
	});
	assert.equal(sessionManager.getLeafId(), user);
});
