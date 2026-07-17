import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_SETTINGS, configPath, loadSettings, settingsDiagnostics } from "../src/settings.js";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-codex-minimal-tools-"));
}

function withAgentDir<T>(fn: (agentDir: string) => T): T {
	const root = tempDir();
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
	const dir = join(agentDir, "extensions", "pi-codex-minimal-tools");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "config.json"), typeof value === "string" ? value : JSON.stringify(value));
}

test("loadSettings returns defaults when config.json is absent", () => {
	withAgentDir(() => {
		assert.deepEqual(loadSettings(), DEFAULT_SETTINGS);
	});
});

test("configPath points to extensions/pi-codex-minimal-tools/config.json", () => {
	withAgentDir((agentDir) => {
		assert.equal(configPath(), join(agentDir, "extensions", "pi-codex-minimal-tools", "config.json"));
	});
});

test("settingsDiagnostics reports malformed config.json", () => {
	withAgentDir((agentDir) => {
		writeConfig(agentDir, "{");
		const diagnostics = settingsDiagnostics();
		assert.equal(diagnostics.length, 1);
		assert.match(diagnostics[0]!, /extensions[/\\]pi-codex-minimal-tools[/\\]config\.json/);
	});
});

test("loadSettings reads flat package config", () => {
	withAgentDir((agentDir) => {
		writeConfig(agentDir, {
			autoEnable: false,
			apiKeyMode: true,
			imageOutputDir: "custom-images",
			imageModel: "gpt-image-1",
			directImageApiFallback: true,
			webSearchEnabled: true,
			requestProfile: {
				responsesMode: "standard",
				patchTransport: "function",
				supportsHostedTools: false,
				supportsParallelTools: false,
			},
		});
		const settings = loadSettings();
		assert.equal(settings.autoEnable, false);
		assert.equal(settings.apiKeyMode, true);
		assert.equal(settings.imageOutputDir, "custom-images");
		assert.equal(settings.imageModel, "gpt-image-1");
		assert.equal(settings.directImageApiFallback, true);
		assert.equal(settings.webSearchEnabled, true);
		assert.deepEqual(settings.requestProfile, {
			responsesMode: "standard",
			patchTransport: "function",
			supportsHostedTools: false,
			supportsParallelTools: false,
		});
		assert.equal(settings.applyPatchEnabled, true);
	});
});

test("loadSettings falls back for invalid enum values", () => {
	withAgentDir((agentDir) => {
		writeConfig(agentDir, {
			imageModel: "bad-model",
			glyphStyle: "bad-style",
			requestProfile: { responsesMode: "lite", patchTransport: "custom" },
		});
		const settings = loadSettings();
		assert.equal(settings.imageModel, DEFAULT_SETTINGS.imageModel);
		assert.equal(settings.glyphStyle, DEFAULT_SETTINGS.glyphStyle);
		assert.deepEqual(settings.requestProfile, {});
	});
});
