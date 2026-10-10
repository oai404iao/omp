import assert from "node:assert/strict";
import test from "node:test";
import { notificationSequence } from "../src/notification.ts";

const kitty = { KITTY_WINDOW_ID: "1" };
const id = "test-notification";
const direct = (body = "Ready for input") => notificationSequence(kitty, body, "unfocused", id)!;

test("Kitty receives a multipart OSC 99 notification with click-to-focus", () => {
	assert.equal(direct(), "\x1b]99;i=test-notification:e=1:a=focus:o=unfocused:d=0;UGk=\x1b\\"
		+ "\x1b]99;i=test-notification:e=1:p=body:d=1;UmVhZHkgZm9yIGlucHV0\x1b\\");
	assert.doesNotMatch(direct(), /a=report/);
});

test("tmux wraps both OSC parts in one DCS and doubles all inner escapes", () => {
	for (const env of [{ ...kitty, TMUX: "/socket,1,0" }, { ...kitty, TMUX_PANE: "%0" }]) {
		const sequence = notificationSequence(env, "Ready for input", "unfocused", id);
		assert.equal(sequence, `\x1bPtmux;${direct().replaceAll("\x1b", "\x1b\x1b")}\x1b\\`);
	}
});

test("unsupported terminals produce no sequence, even inside tmux", () => {
	for (const env of [{}, { TERM: "xterm-kitty" }, { TMUX: "/socket" }, { KITTY_WINDOW_ID: "" }]) {
		assert.equal(notificationSequence(env, "Ready"), undefined);
	}
});

test("base64 safely carries Unicode, semicolons, BEL, and ESC in project names", () => {
	const body = "项目;malicious\x07\x1b]9;injected\nReady";
	const sequence = direct(body);
	assert.ok(sequence.includes(Buffer.from(body).toString("base64")));
	assert.ok(!sequence.includes(body));
	assert.ok(!sequence.includes("\x07"));
	assert.equal(sequence.match(/\x1b\]99;/g)?.length, 2);
});

test("test notifications can bypass focus suppression", () => {
	assert.match(notificationSequence(kitty, "Test", "always", id)!, /o=always/);
});

test("different notifications have unique identifiers", () => {
	const first = notificationSequence(kitty, "Ready")!;
	const second = notificationSequence(kitty, "Ready")!;
	assert.notEqual(first.match(/i=([^:]+)/)?.[1], second.match(/i=([^:]+)/)?.[1]);
});
