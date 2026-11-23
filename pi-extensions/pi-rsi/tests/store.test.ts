import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { feedbackDirectory, saveFeedback } from "../src/store.ts";
import { sandbox } from "./fixture.ts";

test("data paths follow the Pi override, XDG, then ~/.config; resolving does not create them", t => {
	const root = sandbox(t);
	process.env.PI_CODING_AGENT_DIR = "~/custom";
	assert.equal(feedbackDirectory(), join(root, "custom/pi-rsi"));
	delete process.env.PI_CODING_AGENT_DIR;
	assert.equal(feedbackDirectory(), join(root, "xdg/pi/agent/pi-rsi"));
	process.env.XDG_CONFIG_HOME = ".";
	assert.equal(feedbackDirectory(), join(root, ".config/pi/agent/pi-rsi"));
	delete process.env.XDG_CONFIG_HOME;
	assert.equal(feedbackDirectory(), join(root, ".config/pi/agent/pi-rsi"));
	assert.equal(existsSync(feedbackDirectory()), false);
});

test("concurrent feedback on one user message publishes distinct, private JSON files", async t => {
	const root = sandbox(t);
	const directory = join(root, "agent/pi-rsi");
	const target = { projectPath: root, sessionId: "session", userMessageEntryId: "user-entry", finalAssistantEntryId: null };
	await Promise.all([saveFeedback({ ...target, feedback: "good" }), saveFeedback({ ...target, feedback: "bad" })]);
	const files = readdirSync(directory);
	assert.equal(files.length, 2);
	if (process.platform !== "win32") assert.equal(statSync(directory).mode & 0o777, 0o700);
	const feedback = files.map(file => {
		const path = join(directory, file);
		if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
		const record = JSON.parse(readFileSync(path, "utf8"));
		assert.match(record.id, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
		assert.equal(file, `${record.id}.json`);
		assert.equal(new Date(record.createdAt).toISOString(), record.createdAt);
		return record.feedback;
	});
	assert.deepEqual(feedback.sort(), ["bad", "good"]);
});
