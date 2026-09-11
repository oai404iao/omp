import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentScope, RuntimeMode, SubagentSettings } from "./types.ts";

export const CONFIG_FILE_NAME = "subagent.json";

export const DEFAULT_SETTINGS: Readonly<SubagentSettings> = {
	agentScope: "user",
	maxDepth: 3,
	runtimeMode: "background",
	maxConcurrentBackgroundRuns: 4,
	maxIdleRuntimes: 0,
	inheritExtensions: false,
	openAIIdentity: false,
	maxOutputBytes: 50 * 1024,
};

const CONFIG_KEYS = new Set([
	"$schema",
	"agentScope",
	"maxDepth",
	"runtimeMode",
	"maxConcurrentBackgroundRuns",
	"maxIdleRuntimes",
	"inheritExtensions",
	"openAIIdentity",
	"maxOutputBytes",
]);

interface LoadSettingsOptions {
	cwd: string;
	projectTrusted: boolean;
	agentDir?: string;
}

export interface LoadedSettings {
	settings: SubagentSettings;
	sources: string[];
}

type ConfigRecord = Record<string, unknown>;

function asRecord(value: unknown, filePath: string): ConfigRecord {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${filePath}: configuration must be a JSON object`);
	}
	return value as ConfigRecord;
}

function readConfig(filePath: string): ConfigRecord | undefined {
	if (!existsSync(filePath)) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(filePath, "utf8"));
	} catch (error) {
		throw new Error(`${filePath}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	const record = asRecord(parsed, filePath);
	for (const key of Object.keys(record)) {
		if (!CONFIG_KEYS.has(key)) throw new Error(`${filePath}: unknown setting "${key}"`);
	}
	return record;
}

function findNearestProjectConfig(cwd: string): string | undefined {
	let current = resolve(cwd);
	while (true) {
		const candidate = join(current, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
		if (existsSync(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function parseAgentScope(value: unknown, source: string): AgentScope {
	if (value === "user" || value === "project" || value === "both") return value;
	throw new Error(`${source}: agentScope must be "user", "project", or "both"`);
}

function parseRuntimeMode(value: unknown, source: string): RuntimeMode {
	if (value === "foreground" || value === "background") return value;
	throw new Error(`${source}: runtimeMode must be "foreground" or "background"`);
}

function parseBoolean(value: unknown, key: string, source: string): boolean {
	if (typeof value === "boolean") return value;
	throw new Error(`${source}: ${key} must be a boolean`);
}

function parseInteger(
	value: unknown,
	key: string,
	source: string,
	options: { minimum: number; maximum: number },
): number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < options.minimum ||
		value > options.maximum
	) {
		throw new Error(
			`${source}: ${key} must be a safe integer between ${options.minimum} and ${options.maximum}`,
		);
	}
	return value;
}

function applyConfig(
	settings: SubagentSettings,
	config: ConfigRecord,
	source: string,
): SubagentSettings {
	return {
		agentScope:
			config.agentScope === undefined
				? settings.agentScope
				: parseAgentScope(config.agentScope, source),
		maxDepth:
			config.maxDepth === undefined
				? settings.maxDepth
				: parseInteger(config.maxDepth, "maxDepth", source, {
						minimum: 0,
						maximum: Number.MAX_SAFE_INTEGER,
					}),
		runtimeMode:
			config.runtimeMode === undefined
				? settings.runtimeMode
				: parseRuntimeMode(config.runtimeMode, source),
		maxConcurrentBackgroundRuns:
			config.maxConcurrentBackgroundRuns === undefined
				? settings.maxConcurrentBackgroundRuns
				: parseInteger(
						config.maxConcurrentBackgroundRuns,
						"maxConcurrentBackgroundRuns",
						source,
						{
							minimum: 1,
							maximum: Number.MAX_SAFE_INTEGER,
						},
					),
		maxIdleRuntimes:
			config.maxIdleRuntimes === undefined
				? settings.maxIdleRuntimes
				: parseInteger(
						config.maxIdleRuntimes,
						"maxIdleRuntimes",
						source,
						{
							minimum: 0,
							maximum: Number.MAX_SAFE_INTEGER,
						},
					),
		inheritExtensions:
			config.inheritExtensions === undefined
				? settings.inheritExtensions
				: parseBoolean(config.inheritExtensions, "inheritExtensions", source),
		openAIIdentity:
			config.openAIIdentity === undefined
				? settings.openAIIdentity
				: parseBoolean(config.openAIIdentity, "openAIIdentity", source),
		maxOutputBytes:
			config.maxOutputBytes === undefined
				? settings.maxOutputBytes
				: parseInteger(config.maxOutputBytes, "maxOutputBytes", source, {
						minimum: 1024,
						maximum: 1024 * 1024,
					}),
	};
}

export function loadSettings(options: LoadSettingsOptions): LoadedSettings {
	let settings: SubagentSettings = { ...DEFAULT_SETTINGS };
	const sources: string[] = [];
	const userPath = join(options.agentDir ?? getAgentDir(), CONFIG_FILE_NAME);
	const userConfig = readConfig(userPath);
	if (userConfig) {
		settings = applyConfig(settings, userConfig, userPath);
		sources.push(userPath);
	}

	if (options.projectTrusted) {
		const projectPath = findNearestProjectConfig(options.cwd);
		if (projectPath) {
			const projectConfig = readConfig(projectPath);
			if (projectConfig) {
				settings = applyConfig(settings, projectConfig, projectPath);
				sources.push(projectPath);
			}
		}
	}

	return { settings, sources };
}
