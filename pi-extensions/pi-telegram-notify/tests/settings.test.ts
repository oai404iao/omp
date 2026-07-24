import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_SETTINGS, configPath, isConfigured, loadSettings, settingsDiagnostics } from "../src/settings.js";

function withAgentDir<T>(fn: (agentDir: string) => T): T {
	const root = mkdtempSync(join(tmpdir(), "pi-telegram-notify-"));
	const agentDir = join(root, "agent");
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		return fn(agentDir);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
}

function writeConfig(agentDir: string, value: unknown): void {
	const dir = join(agentDir, "extensions", "pi-telegram-notify");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "config.json"), typeof value === "string" ? value : JSON.stringify(value));
}

test("uses Pi's configured agent directory and defaults without config", () => {
	withAgentDir((agentDir) => {
		assert.equal(configPath(), join(agentDir, "extensions", "pi-telegram-notify", "config.json"));
		assert.deepEqual(loadSettings(), DEFAULT_SETTINGS);
		assert.equal(isConfigured(loadSettings()), false);
	});
});

test("reads credentials, number chat IDs, and timeout from config", () => {
	withAgentDir((agentDir) => {
		writeConfig(agentDir, {
			enabled: false,
			botToken: "123:token",
			chatId: -1001234567890,
			requestTimeoutMs: 30_000,
		});
		const settings = loadSettings();
		assert.equal(settings.enabled, false);
		assert.equal(settings.botToken, "123:token");
		assert.equal(settings.chatId, "-1001234567890");
		assert.equal(settings.requestTimeoutMs, 30_000);
		assert.equal(isConfigured(settings), true);
	});
});

test("reports malformed JSON without throwing", () => {
	withAgentDir((agentDir) => {
		writeConfig(agentDir, "{");
		assert.deepEqual(loadSettings(), DEFAULT_SETTINGS);
		assert.match(settingsDiagnostics()[0]!, /extensions[/\\]pi-telegram-notify[/\\]config\.json/);
	});
});
