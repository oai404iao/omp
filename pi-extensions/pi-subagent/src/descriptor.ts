import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type {
	AgentScope,
	AgentSnapshot,
	AgentSource,
	ReportDelivery,
	SubagentDescriptor,
	SubagentMode,
	SubagentProviderName,
} from "./types.ts";

export const DESCRIPTOR_CUSTOM_TYPE = "pi-subagent/descriptor";
export const DESCRIPTOR_VERSION = 1;

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const AGENT_SOURCES = new Set<AgentSource>(["bundled", "user", "project"]);
const MODES = new Set<SubagentMode>(["one-shot", "continuable"]);
const PROVIDERS = new Set<SubagentProviderName>(["spawn", "fork"]);
const REPORT_DELIVERIES = new Set<ReportDelivery>(["wakeup", "quiet"]);
const AGENT_SCOPES = new Set<AgentScope>(["user", "project", "both"]);
const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

type UnknownRecord = Record<string, unknown>;

export type DescriptorFold =
	| { kind: "none" }
	| { kind: "valid"; descriptor: SubagentDescriptor }
	| { kind: "corrupt"; message: string };

function record(value: unknown, field: string): UnknownRecord {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${field} must be an object`);
	}
	return value as UnknownRecord;
}

function string(value: unknown, field: string, allowEmpty = false): string {
	if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
		throw new Error(`${field} must be ${allowEmpty ? "a string" : "a non-empty string"}`);
	}
	return value;
}

function optionalString(value: unknown, field: string): string | undefined {
	return value === undefined ? undefined : string(value, field);
}

function limitedString(value: unknown, field: string, maxLength: number): string {
	const parsed = string(value, field);
	if (parsed.length > maxLength) throw new Error(`${field} exceeds ${maxLength} characters`);
	return parsed;
}

function safeNatural(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${field} must be a non-negative safe integer`);
	}
	return value;
}

function boundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
	const parsed = safeNatural(value, field);
	if (parsed < minimum || parsed > maximum) {
		throw new Error(`${field} must be between ${minimum} and ${maximum}`);
	}
	return parsed;
}

function boolean(value: unknown, field: string): boolean {
	if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
	return value;
}

function stringArray(value: unknown, field: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (
		!Array.isArray(value) ||
		value.some(
			(item) => typeof item !== "string" || item.trim().length === 0 || item.length > 128,
		)
	) {
		throw new Error(`${field} must be an array of non-empty strings`);
	}
	return [...new Set(value)];
}

function parseAgent(value: unknown): AgentSnapshot {
	const input = record(value, "agent");
	const source = string(input.source, "agent.source") as AgentSource;
	if (!AGENT_SOURCES.has(source)) throw new Error(`agent.source is unsupported: ${source}`);
	const thinking = optionalString(input.thinking, "agent.thinking") as ThinkingLevel | undefined;
	if (thinking && !THINKING_LEVELS.has(thinking)) throw new Error(`agent.thinking is unsupported: ${thinking}`);
	const tools = stringArray(input.tools, "agent.tools");
	const model = optionalString(input.model, "agent.model");
	const name = limitedString(input.name, "agent.name", 64);
	if (!AGENT_NAME_PATTERN.test(name)) throw new Error("agent.name has an invalid format");
	return {
		name,
		description: limitedString(input.description, "agent.description", 1000),
		...(tools !== undefined ? { tools } : {}),
		...(model !== undefined ? { model } : {}),
		...(thinking !== undefined ? { thinking } : {}),
		systemPrompt: limitedString(input.systemPrompt, "agent.systemPrompt", 256 * 1024),
		source,
	};
}

export function parseDescriptor(value: unknown): SubagentDescriptor {
	const input = record(value, "descriptor");
	if (input.version !== DESCRIPTOR_VERSION) {
		throw new Error(`unsupported descriptor version: ${String(input.version)}`);
	}
	const mode = string(input.mode, "mode") as SubagentMode;
	if (!MODES.has(mode)) throw new Error(`unsupported descriptor mode: ${mode}`);
	const provider = string(input.provider, "provider") as SubagentProviderName;
	if (!PROVIDERS.has(provider)) throw new Error(`unsupported descriptor provider: ${provider}`);
	const thinkingLevel = string(input.thinkingLevel, "thinkingLevel") as ThinkingLevel;
	if (!THINKING_LEVELS.has(thinkingLevel)) throw new Error(`unsupported thinkingLevel: ${thinkingLevel}`);

	const model = record(input.model, "model");
	const runtime = record(input.runtime, "runtime");
	const agentScope = string(runtime.agentScope, "runtime.agentScope") as AgentScope;
	if (!AGENT_SCOPES.has(agentScope)) throw new Error(`unsupported runtime.agentScope: ${agentScope}`);
	const reportDelivery = string(runtime.reportDelivery, "runtime.reportDelivery") as ReportDelivery;
	if (!REPORT_DELIVERIES.has(reportDelivery)) {
		throw new Error(`unsupported runtime.reportDelivery: ${reportDelivery}`);
	}

	const createdAt = string(input.createdAt, "createdAt");
	if (Number.isNaN(Date.parse(createdAt))) throw new Error("createdAt must be an ISO date string");

	return {
		version: DESCRIPTOR_VERSION,
		mode,
		provider,
		label: limitedString(input.label, "label", 200),
		parentSessionId: string(input.parentSessionId, "parentSessionId"),
		...(optionalString(input.parentSessionFile, "parentSessionFile")
			? { parentSessionFile: input.parentSessionFile as string }
			: {}),
		depth: safeNatural(input.depth, "depth"),
		cwd: string(input.cwd, "cwd"),
		createdAt,
		agent: parseAgent(input.agent),
		model: {
			provider: string(model.provider, "model.provider"),
			id: string(model.id, "model.id"),
		},
		thinkingLevel,
		runtime: {
			agentScope,
			maxDepth: safeNatural(runtime.maxDepth, "runtime.maxDepth"),
			enableRunInBackground:
				runtime.enableRunInBackground === undefined
					? true
					: boolean(runtime.enableRunInBackground, "runtime.enableRunInBackground"),
			defaultBackground: boolean(runtime.defaultBackground, "runtime.defaultBackground"),
			reportDelivery,
			inheritExtensions: boolean(runtime.inheritExtensions, "runtime.inheritExtensions"),
			maxOutputBytes: boundedInteger(
				runtime.maxOutputBytes,
				"runtime.maxOutputBytes",
				1024,
				1024 * 1024,
			),
		},
	};
}

export function foldDescriptor(entries: readonly SessionEntry[]): DescriptorFold {
	let found = false;
	let value: unknown;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== DESCRIPTOR_CUSTOM_TYPE) continue;
		found = true;
		value = entry.data;
	}
	if (!found) return { kind: "none" };
	try {
		return { kind: "valid", descriptor: parseDescriptor(value) };
	} catch (error) {
		return { kind: "corrupt", message: error instanceof Error ? error.message : String(error) };
	}
}
