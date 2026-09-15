import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	DEFAULT_GLOBAL_SETTINGS,
	DEFAULT_SETTINGS,
	configPath,
	loadSettings,
	settingsDiagnostics,
	updateConfig,
} from "../src/settings.js";

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
		assert.equal(loadSettings().deferApplyPatchRendering, false);
		assert.equal(Object.hasOwn(DEFAULT_SETTINGS, "strictPatchMode"), false);
		assert.equal(Object.hasOwn(DEFAULT_SETTINGS, "allowAbsolutePatchPaths"), false);
	});
});

test("config schema exposes only global settings and their defaults", () => {
	const schema = JSON.parse(readFileSync(new URL("../config.schema.json", import.meta.url), "utf8"));
	assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
	assert.equal(schema.additionalProperties, false);
	assert.deepEqual(
		Object.keys(schema.properties).filter((key) => key !== "$schema").sort(),
		Object.keys(DEFAULT_GLOBAL_SETTINGS).sort(),
	);
	for (const [key, value] of Object.entries(DEFAULT_GLOBAL_SETTINGS)) {
		assert.deepEqual(schema.properties[key].default, value, `schema default for ${key}`);
	}
	assert.equal(
		Object.values(schema.properties).some(
			(value: any) => value?.deprecated === true,
		),
		false,
	);
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

test("loadSettings reads package config and nested request profile", () => {
	withAgentDir((agentDir) => {
		writeConfig(agentDir, {
			autoEnable: false,
			webSocketEnabled: false,
			apiKeyMode: true,
			openaiTransport: "websocket-cached",
			openaiWebSocketPrewarm: false,
			fastMode: true,
			imageOutputDir: "custom-images",
			imageModel: "gpt-image-1",
			directImageApiFallback: true,
			webSearchEnabled: true,
			additionalModelIds: [
				" openai/deepseek-v4-flash ",
				"OPENAI/deepseek-v4-flash",
				"invalid",
			],
			compactionMode: "responses",
			requestProfile: {
				responsesMode: "standard",
				reasoningSummary: "detailed",
				systemPromptPlacement: "developer",
				patchTransport: "function",
				supportsHostedTools: false,
				supportsParallelTools: false,
			},
		});
		const settings = loadSettings();
		assert.equal(settings.autoEnable, false);
		assert.equal(settings.webSocketEnabled, false);
		assert.equal(settings.apiKeyMode, true);
		assert.equal(settings.openaiTransport, "websocket-cached");
		assert.equal(settings.openaiWebSocketPrewarm, false);
		assert.equal(settings.fastMode, true);
		assert.equal(settings.imageOutputDir, "custom-images");
		assert.equal(settings.imageModel, "gpt-image-1");
		assert.equal(settings.directImageApiFallback, true);
		assert.equal(settings.webSearchEnabled, true);
		assert.deepEqual(settings.additionalModelIds, ["openai/deepseek-v4-flash"]);
		assert.equal(settings.compactionMode, "responses");
		assert.deepEqual(settings.requestProfile, {
			responsesMode: "standard",
			reasoningSummary: "detailed",
			systemPromptPlacement: "developer",
			patchTransport: "function",
			supportsHostedTools: false,
			supportsParallelTools: false,
		});
		assert.equal(settings.applyPatchEnabled, true);
	});
});

test("updateConfig preserves existing keys and writes persistent Fast mode settings", () => {
	withAgentDir((agentDir) => {
		writeConfig(agentDir, {
			$schema: "/tmp/config.schema.json",
			webSearchEnabled: true,
		});
		updateConfig({
			fastMode: true,
		});
		const raw = JSON.parse(readFileSync(configPath(), "utf8"));
		assert.equal(raw.$schema, "/tmp/config.schema.json");
		assert.equal(raw.webSearchEnabled, true);
		assert.equal(raw.fastMode, true);
		assert.equal(loadSettings().fastMode, true);
	});
});

test("updateConfig refuses to overwrite malformed config", () => {
	withAgentDir((agentDir) => {
		writeConfig(agentDir, "{");
		assert.throws(() => updateConfig({ fastMode: true }), /Cannot update malformed config/);
		assert.equal(readFileSync(configPath(), "utf8"), "{");
	});
});

test("loadSettings migrates the old context-management compaction name", () => {
	withAgentDir((agentDir) => {
		writeConfig(agentDir, {
			compactionMode: "responses-context-management",
		});
		assert.equal(loadSettings().compactionMode, "responses");
	});
});

test("loadSettings accepts Lite with custom patch transport", () => {
	withAgentDir((agentDir) => {
		writeConfig(agentDir, {
			imageModel: "bad-model",
			glyphStyle: "bad-style",
			openaiTransport: "bad-transport",
			requestProfile: {
				responsesMode: "lite",
				reasoningSummary: "concise",
				patchTransport: "custom",
			},
		});
		const settings = loadSettings();
		assert.equal(settings.imageModel, DEFAULT_SETTINGS.imageModel);
		assert.equal(settings.glyphStyle, DEFAULT_SETTINGS.glyphStyle);
		assert.equal(settings.openaiTransport, DEFAULT_SETTINGS.openaiTransport);
		assert.deepEqual(settings.requestProfile, {
			responsesMode: "lite",
			reasoningSummary: "concise",
			patchTransport: "custom",
		});
	});
});
