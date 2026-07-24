import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const PACKAGE_NAME = "pi-telegram-notify";
export const CONFIG_FILE_NAME = "config.json";

export interface TelegramNotifySettings {
	enabled: boolean;
	botToken?: string;
	chatId?: string;
	requestTimeoutMs: number;
}

export interface ConfiguredTelegramNotifySettings extends TelegramNotifySettings {
	botToken: string;
	chatId: string;
}

export const DEFAULT_SETTINGS: TelegramNotifySettings = {
	enabled: true,
	requestTimeoutMs: 10_000,
};

type SettingsRecord = Record<string, unknown>;
const settingsParseWarnings = new Map<string, string>();

function expandHome(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/")) return join(homedir(), input.slice(2));
	return input;
}

/**
 * Resolve Pi's user agent directory without hard-coding one installation path.
 * This mirrors Pi's XDG-aware convention and respects PI_CODING_AGENT_DIR.
 */
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
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as SettingsRecord) : undefined;
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

function nonBlankString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function chatIdSetting(value: unknown): string | undefined {
	const stringValue = nonBlankString(value);
	if (stringValue) return stringValue;
	return typeof value === "number" && Number.isSafeInteger(value) ? String(value) : undefined;
}

function timeoutSetting(value: unknown): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1_000 && value <= 120_000
		? value
		: DEFAULT_SETTINGS.requestTimeoutMs;
}

export function loadSettings(): TelegramNotifySettings {
	const raw = readRawConfig();
	const botToken = nonBlankString(raw.botToken);
	const chatId = chatIdSetting(raw.chatId);
	return {
		enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_SETTINGS.enabled,
		requestTimeoutMs: timeoutSetting(raw.requestTimeoutMs),
		...(botToken ? { botToken } : {}),
		...(chatId ? { chatId } : {}),
	};
}

export function isConfigured(settings: TelegramNotifySettings): settings is ConfiguredTelegramNotifySettings {
	return typeof settings.botToken === "string" && typeof settings.chatId === "string";
}

export function settingsDiagnostics(): string[] {
	readRawConfig();
	const path = configPath();
	const warning = settingsParseWarnings.get(path);
	return warning ? [`${path}: ${warning}`] : [];
}
