import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
	openaiTransport: "sse" | "websocket" | "websocket-cached" | "auto";
	openaiWebSocketPrewarm: boolean;
	fastMode: boolean;
	compactionMode: "pi" | "responses" | "responses-compact";
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
	additionalModelIds: string[];
	deferApplyPatchRendering: boolean;
}

export const DEFAULT_SETTINGS: CodexMinimalToolsSettings = {
	enabled: true,
	glyphStyle: "unicode",
	autoEnable: true,
	nativeProviderTools: true,
	openaiTransport: "sse",
	openaiWebSocketPrewarm: true,
	fastMode: false,
	compactionMode: "pi",
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
	additionalModelIds: [],
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

function modelIdListSetting(raw: SettingsRecord): string[] {
	const value = raw.additionalModelIds;
	if (!Array.isArray(value)) return [...DEFAULT_SETTINGS.additionalModelIds];

	const seen = new Set<string>();
	const modelIds: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") continue;
		const modelId = item.trim();
		if (!modelId.includes("/")) continue;
		const normalized = modelId.toLowerCase();
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		modelIds.push(modelId);
	}
	return modelIds;
}

function imageModelSetting(raw: SettingsRecord): CodexMinimalToolsSettings["imageModel"] {
	const value = raw.imageModel;
	return value === "gpt-image-2" || value === "gpt-image-1.5" || value === "gpt-image-1" ? value : DEFAULT_SETTINGS.imageModel;
}

function glyphStyleSetting(raw: SettingsRecord): CodexMinimalToolsSettings["glyphStyle"] {
	const value = raw.glyphStyle;
	return value === "ascii" || value === "unicode" ? value : DEFAULT_SETTINGS.glyphStyle;
}

function openaiTransportSetting(raw: SettingsRecord): CodexMinimalToolsSettings["openaiTransport"] {
	const value = raw.openaiTransport;
	return value === "sse" || value === "websocket" || value === "websocket-cached" || value === "auto"
		? value
		: DEFAULT_SETTINGS.openaiTransport;
}

function compactionModeSetting(raw: SettingsRecord): CodexMinimalToolsSettings["compactionMode"] {
	const value = raw.compactionMode;
	if (value === "responses-context-management") return "responses";
	return value === "pi" || value === "responses" || value === "responses-compact"
		? value
		: DEFAULT_SETTINGS.compactionMode;
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
		openaiTransport: openaiTransportSetting(raw),
		openaiWebSocketPrewarm: boolSetting(raw, "openaiWebSocketPrewarm"),
		fastMode: boolSetting(raw, "fastMode"),
		compactionMode: compactionModeSetting(raw),
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
		additionalModelIds: modelIdListSetting(raw),
		deferApplyPatchRendering: boolSetting(raw, "deferApplyPatchRendering"),
	};
}

export function updateConfig(patch: Partial<CodexMinimalToolsSettings>): string {
	const path = configPath();
	let raw: SettingsRecord = {};
	if (existsSync(path)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(path, "utf8"));
		} catch (error) {
			throw new Error(`Cannot update malformed config ${path}: ${error instanceof Error ? error.message : String(error)}`);
		}
		const record = asRecord(parsed);
		if (!record) throw new Error(`Cannot update config ${path}: root value must be a JSON object`);
		raw = record;
	}

	const next = { ...raw, ...patch };
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	settingsParseWarnings.delete(path);
	return path;
}

export function resolveSettingsRelativePath(value: string, settingsPath = configPath()): string {
	const expanded = expandHome(value.trim());
	return isAbsolute(expanded) ? expanded : resolve(dirname(settingsPath), expanded);
}
