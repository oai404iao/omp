import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { CodexRequestProfileOverride } from "./codex-request-profile.js";

export const PACKAGE_NAME = "pi-codex-minimal-tools";
export const CONFIG_FILE_NAME = "config.json";

export interface CodexMinimalToolsSettings {
	enabled: boolean;
	glyphStyle: "unicode" | "ascii";
	autoEnable: boolean;
	nativeProviderTools: boolean;
	compactionMode: "pi" | "responses-context-management" | "responses-compact";
	nativeCompactionThreshold: number;
	requestProfile: CodexRequestProfileOverride;
	apiKeyMode: boolean;
	imageGeneration: boolean;
	webSearchEnabled: boolean;
	imageOutputDir: string;
	imageModel: "gpt-image-2" | "gpt-image-1.5" | "gpt-image-1";
	directImageApiFallback: boolean;
	viewImage: boolean;
	viewImageWorkspaceOnly: boolean;
	applyPatchEnabled: boolean;
	allowAbsolutePatchPaths: boolean;
	deferApplyPatchRendering: boolean;
}

export const DEFAULT_SETTINGS: CodexMinimalToolsSettings = {
	enabled: true,
	glyphStyle: "unicode",
	autoEnable: true,
	nativeProviderTools: true,
	compactionMode: "pi",
	nativeCompactionThreshold: 0,
	requestProfile: {},
	apiKeyMode: false,
	imageGeneration: true,
	webSearchEnabled: false,
	imageOutputDir: ".pi/openai-codex-images",
	imageModel: "gpt-image-2",
	directImageApiFallback: false,
	viewImage: false,
	viewImageWorkspaceOnly: false,
	applyPatchEnabled: true,
	allowAbsolutePatchPaths: false,
	deferApplyPatchRendering: false,
};

type SettingsRecord = Record<string, unknown>;
const settingsParseWarnings = new Map<string, string>();

function expandHome(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/")) return join(homedir(), input.slice(2));
	return input;
}

export function piUserDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR?.trim();
	if (envDir) return resolve(expandHome(envDir));

	const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
	const xdgAgentDir = xdgConfigHome
		? resolve(expandHome(xdgConfigHome), "pi", "agent")
		: join(homedir(), ".config", "pi", "agent");
	if (existsSync(xdgAgentDir)) return xdgAgentDir;

	return resolve(expandHome("~/.pi/agent"));
}

export function configDir(agentDir = piUserDir()): string {
	return join(agentDir, "extensions", PACKAGE_NAME);
}

export function configPath(agentDir = piUserDir()): string {
	return join(configDir(agentDir), CONFIG_FILE_NAME);
}

function asRecord(value: unknown): SettingsRecord | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as SettingsRecord) : undefined;
}

export function readRawConfig(): SettingsRecord {
	const path = configPath();
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		settingsParseWarnings.delete(path);
		return asRecord(parsed) ?? {};
	} catch (error) {
		settingsParseWarnings.set(path, error instanceof Error ? error.message : String(error));
		return {};
	}
}

export function settingsDiagnostics(): string[] {
	readRawConfig();
	const path = configPath();
	const warning = settingsParseWarnings.get(path);
	return warning ? [`${path}: ${warning}`] : [];
}

function boolSetting(raw: SettingsRecord, key: keyof CodexMinimalToolsSettings): boolean {
	const fallback = DEFAULT_SETTINGS[key];
	const value = raw[key as string];
	return typeof value === "boolean" ? value : Boolean(fallback);
}

function stringSetting(raw: SettingsRecord, key: keyof CodexMinimalToolsSettings): string {
	const fallback = String(DEFAULT_SETTINGS[key]);
	const value = raw[key as string];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function imageModelSetting(raw: SettingsRecord): CodexMinimalToolsSettings["imageModel"] {
	const value = raw.imageModel;
	return value === "gpt-image-2" || value === "gpt-image-1.5" || value === "gpt-image-1" ? value : DEFAULT_SETTINGS.imageModel;
}

function glyphStyleSetting(raw: SettingsRecord): CodexMinimalToolsSettings["glyphStyle"] {
	const value = raw.glyphStyle;
	return value === "ascii" || value === "unicode" ? value : DEFAULT_SETTINGS.glyphStyle;
}

function compactionModeSetting(raw: SettingsRecord): CodexMinimalToolsSettings["compactionMode"] {
	const value = raw.compactionMode;
	return value === "pi" || value === "responses-context-management" || value === "responses-compact"
		? value
		: DEFAULT_SETTINGS.compactionMode;
}

function nonNegativeIntegerSetting(raw: SettingsRecord, key: keyof CodexMinimalToolsSettings): number {
	const fallback = Number(DEFAULT_SETTINGS[key]);
	const value = raw[key as string];
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function requestProfileSetting(raw: SettingsRecord): CodexRequestProfileOverride {
	const value = asRecord(raw.requestProfile);
	if (!value) return {};
	const profile: CodexRequestProfileOverride = {};
	if (value.responsesMode === "standard" || value.responsesMode === "lite") profile.responsesMode = value.responsesMode;
	if (value.systemPromptPlacement === "instructions" || value.systemPromptPlacement === "developer") profile.systemPromptPlacement = value.systemPromptPlacement;
	if (value.patchTransport === "function" || value.patchTransport === "custom") profile.patchTransport = value.patchTransport;
	if (typeof value.supportsHostedTools === "boolean") profile.supportsHostedTools = value.supportsHostedTools;
	if (typeof value.supportsParallelTools === "boolean") profile.supportsParallelTools = value.supportsParallelTools;
	return profile;
}

export function loadSettings(_cwd?: string): CodexMinimalToolsSettings {
	const raw = readRawConfig();
	return {
		enabled: boolSetting(raw, "enabled"),
		glyphStyle: glyphStyleSetting(raw),
		autoEnable: boolSetting(raw, "autoEnable"),
		nativeProviderTools: boolSetting(raw, "nativeProviderTools"),
		compactionMode: compactionModeSetting(raw),
		nativeCompactionThreshold: nonNegativeIntegerSetting(raw, "nativeCompactionThreshold"),
		requestProfile: requestProfileSetting(raw),
		apiKeyMode: boolSetting(raw, "apiKeyMode"),
		imageGeneration: boolSetting(raw, "imageGeneration"),
		webSearchEnabled: boolSetting(raw, "webSearchEnabled"),
		imageOutputDir: stringSetting(raw, "imageOutputDir"),
		imageModel: imageModelSetting(raw),
		directImageApiFallback: boolSetting(raw, "directImageApiFallback"),
		viewImage: boolSetting(raw, "viewImage"),
		viewImageWorkspaceOnly: boolSetting(raw, "viewImageWorkspaceOnly"),
		applyPatchEnabled: boolSetting(raw, "applyPatchEnabled"),
		allowAbsolutePatchPaths: boolSetting(raw, "allowAbsolutePatchPaths"),
		deferApplyPatchRendering: boolSetting(raw, "deferApplyPatchRendering"),
	};
}

export function resolveSettingsRelativePath(value: string, settingsPath = configPath()): string {
	const expanded = expandHome(value.trim());
	return isAbsolute(expanded) ? expanded : resolve(dirname(settingsPath), expanded);
}
