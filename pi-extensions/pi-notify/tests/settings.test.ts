import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { configPath, isTelegramConfigured, loadSettings, notificationChannel } from "../src/settings.ts";

const scratch = process.env.TMPDIR || join(homedir(), ".local", "state", "agents", "tmp");

function setup(t: TestContext) {
	mkdirSync(scratch, { recursive: true });
	const dir = mkdtempSync(join(scratch, "pi-notify-settings-"));
	const originalEnv = process.env;
	process.env = { ...originalEnv, HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "xdg"), PI_CODING_AGENT_DIR: join(dir, "agent") };
	t.after(() => { process.env = originalEnv; });
	return {
		dir,
		write(value: unknown) {
			mkdirSync(join(process.env.PI_CODING_AGENT_DIR!, "extensions", "pi-notify"), { recursive: true });
			writeFileSync(configPath(), JSON.stringify(value));
		},
	};
}

test("missing, malformed, and non-object settings safely default to local without writes", (t) => {
	const h = setup(t);
	const defaults = { channel: "local", telegram: { enabled: true, requestTimeoutMs: 10_000 } };
	assert.deepEqual(loadSettings(), defaults);
	assert.equal(existsSync(process.env.PI_CODING_AGENT_DIR!), false);
	for (const value of [null, [], true, 42, "telegram", {}]) {
		h.write(value);
		assert.deepEqual(loadSettings(), defaults);
		assert.equal(notificationChannel(), "local");
	}
	writeFileSync(configPath(), "{");
	assert.deepEqual(loadSettings(), defaults);
	assert.equal(readFileSync(configPath(), "utf8"), "{");
	assert.deepEqual(readdirSync(join(process.env.PI_CODING_AGENT_DIR!, "extensions", "pi-notify")), ["config.json"]);
});

test("settings use only nested new credentials and are reread on every call", (t) => {
	const h = setup(t);
	for (const channel of ["local", "telegram", "both"]) {
		h.write({ channel, telegram: { botToken: "  FAKE_NEW_TOKEN  ", chatId: "  FAKE_NEW_CHAT  " } });
		const settings = loadSettings();
		assert.equal(settings.channel, channel);
		assert.deepEqual(settings.telegram, { enabled: true, botToken: "FAKE_NEW_TOKEN", chatId: "FAKE_NEW_CHAT", requestTimeoutMs: 10_000 });
		assert.equal(isTelegramConfigured(settings.telegram), true);
	}
	h.write({ channel: "Telegram", botToken: "FAKE_FLAT_TOKEN", chatId: "FAKE_FLAT_CHAT", telegram: [] });
	assert.equal(notificationChannel(), "local");
	assert.equal(isTelegramConfigured(loadSettings().telegram), false);
	h.write({ channel: "both", telegram: { enabled: false, botToken: "FAKE_NEW_TOKEN", chatId: "FAKE_NEW_CHAT" } });
	assert.equal(loadSettings().telegram.enabled, false);
	assert.equal(notificationChannel(), "both");
});

test("chat IDs accept trimmed strings and safe integers only", (t) => {
	const h = setup(t);
	for (const [value, expected] of [["  -10042  ", "-10042"], [0, "0"], [-10042, "-10042"], [Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)]] as const) {
		h.write({ telegram: { botToken: "FAKE_NEW_TOKEN", chatId: value } });
		assert.equal(loadSettings().telegram.chatId, expected);
		assert.equal(isTelegramConfigured(loadSettings().telegram), true);
	}
	for (const value of [" ", null, {}, [], true, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
		h.write({ telegram: { botToken: "FAKE_NEW_TOKEN", chatId: value } });
		assert.equal(loadSettings().telegram.chatId, undefined);
		assert.equal(isTelegramConfigured(loadSettings().telegram), false);
	}
	for (const value of [" ", null, 123, true, {}]) {
		h.write({ telegram: { botToken: value, chatId: "FAKE_NEW_CHAT" } });
		assert.equal(isTelegramConfigured(loadSettings().telegram), false);
	}
});

test("enabled and request timeout validate at the settings boundary", (t) => {
	const h = setup(t);
	for (const enabled of [undefined, null, "false", 0, true]) {
		h.write({ telegram: { enabled } });
		assert.equal(loadSettings().telegram.enabled, true);
	}
	for (const timeout of [1000, 10_000, 120_000]) {
		h.write({ telegram: { enabled: false, requestTimeoutMs: timeout } });
		assert.equal(loadSettings().telegram.requestTimeoutMs, timeout);
		assert.equal(loadSettings().telegram.enabled, false);
	}
	for (const timeout of [999, 120_001, -1, 1000.5, "1000", null]) {
		h.write({ telegram: { requestTimeoutMs: timeout } });
		assert.equal(loadSettings().telegram.requestTimeoutMs, 10_000);
	}
});

test("host agent directory precedence is explicit override, existing XDG, then legacy home", (t) => {
	const h = setup(t);
	const suffix = ["extensions", "pi-notify", "config.json"];
	const resolvedPath = () => execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval",
		`import { configPath } from ${JSON.stringify(new URL("../src/settings.ts", import.meta.url).href)}; process.stdout.write(configPath());`,
	], { env: process.env, encoding: "utf8" });
	assert.equal(resolvedPath(), join(h.dir, "agent", ...suffix));
	delete process.env.PI_CODING_AGENT_DIR;
	assert.equal(resolvedPath(), join(h.dir, "home", ".pi", "agent", ...suffix));
	mkdirSync(join(h.dir, "xdg", "pi", "agent"), { recursive: true });
	assert.equal(resolvedPath(), join(h.dir, "xdg", "pi", "agent", ...suffix));
	process.env.PI_CODING_AGENT_DIR = "~/custom-agent";
	assert.equal(resolvedPath(), join(h.dir, "home", "custom-agent", ...suffix));
	delete process.env.PI_CODING_AGENT_DIR;
	delete process.env.XDG_CONFIG_HOME;
	mkdirSync(join(h.dir, "home", ".config", "pi", "agent"), { recursive: true });
	assert.equal(resolvedPath(), join(h.dir, "home", ".config", "pi", "agent", ...suffix));
});
