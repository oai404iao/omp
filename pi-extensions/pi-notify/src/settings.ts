import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type NotificationChannel = "local" | "telegram" | "both";

export interface TelegramSettings {
	enabled: boolean;
	botToken?: string;
	chatId?: string;
	requestTimeoutMs: number;
}

export interface ConfiguredTelegramSettings extends TelegramSettings {
	botToken: string;
	chatId: string;
}

export interface NotificationSettings {
	channel: NotificationChannel;
	telegram: TelegramSettings;
}

function expandHome(path: string): string {
	return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function piUserDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR?.trim();
	if (envDir) return resolve(expandHome(envDir));
	const xdgHome = process.env.XDG_CONFIG_HOME?.trim();
	const xdgAgentDir = xdgHome ? resolve(expandHome(xdgHome), "pi", "agent") : join(homedir(), ".config", "pi", "agent");
	return existsSync(xdgAgentDir) ? xdgAgentDir : join(homedir(), ".pi", "agent");
}

export function configPath(): string {
	return join(piUserDir(), "extensions", "pi-notify", "config.json");
}

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nonBlankString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function loadSettings(): NotificationSettings {
	let raw: Record<string, unknown> = {};
	try {
		raw = asRecord(JSON.parse(readFileSync(configPath(), "utf8")));
	} catch {
		// Missing or invalid configuration must never opt into network delivery.
	}
	const telegram = asRecord(raw.telegram);
	const botToken = nonBlankString(telegram.botToken);
	const chatId = nonBlankString(telegram.chatId) ??
		(typeof telegram.chatId === "number" && Number.isSafeInteger(telegram.chatId) ? String(telegram.chatId) : undefined);
	const timeout = telegram.requestTimeoutMs;
	return {
		channel: raw.channel === "telegram" || raw.channel === "both" ? raw.channel : "local",
		telegram: {
			enabled: typeof telegram.enabled === "boolean" ? telegram.enabled : true,
			requestTimeoutMs: typeof timeout === "number" && Number.isSafeInteger(timeout) && timeout >= 1_000 && timeout <= 120_000
				? timeout : 10_000,
			...(botToken ? { botToken } : {}),
			...(chatId ? { chatId } : {}),
		},
	};
}

export function notificationChannel(): NotificationChannel {
	return loadSettings().channel;
}

export function isTelegramConfigured(settings: TelegramSettings): settings is ConfiguredTelegramSettings {
	return typeof settings.botToken === "string" && typeof settings.chatId === "string";
}
