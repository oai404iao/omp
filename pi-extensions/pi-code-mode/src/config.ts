import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { protocolMode, type ProtocolMode } from "./protocol.ts";
import { visibilityMode, type VisibilityMode } from "./visibility.ts";

export interface CodeModeConfig { hostPath: string; protocol: ProtocolMode; visibility: VisibilityMode; maxCells: number }
export interface Configuration { value: CodeModeConfig; path: string; sources: Record<keyof CodeModeConfig, "default" | "config" | "CLI"> }
const keys = ["version", "hostPath", "protocol", "visibility", "maxCells"];
function capacity(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 4) throw new Error("maxCells must be an integer from 1 to 4");
	return value;
}
export function configuration(pi: Pick<ExtensionAPI, "getFlag">, agentDir = getAgentDir()): Configuration {
	const path = join(agentDir, "extensions/pi-code-mode/config.json");
	let data: Record<string, unknown> = {};
	try {
		const text = readFileSync(path, "utf8");
		if (Buffer.byteLength(text) > 16 * 1024) throw new Error("Configuration exceeds 16 KiB");
		const parsed: unknown = JSON.parse(text);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Configuration must be an object");
		data = parsed as Record<string, unknown>;
		if (data.version !== 1 || Object.keys(data).some((key) => !keys.includes(key))) throw new Error("Expected version 1 and only hostPath/protocol/visibility/maxCells; grants cannot be saved here");
		if (data.hostPath !== undefined && (typeof data.hostPath !== "string" || !isAbsolute(data.hostPath))) throw new Error("hostPath must be absolute");
		if ("protocol" in data) protocolMode(data.protocol);
		if ("visibility" in data) visibilityMode(data.visibility);
		if ("maxCells" in data) capacity(data.maxCells);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Invalid Code Mode configuration at ${path}`, { cause: error });
	}
	const sources: Configuration["sources"] = { hostPath: "default", protocol: "default", visibility: "default", maxCells: "default" };
	const pick = (key: keyof CodeModeConfig, flag: string, fallback: unknown): unknown => {
		const explicit = pi.getFlag(flag);
		if (explicit !== undefined) { sources[key] = "CLI"; return explicit; }
		if (data[key] !== undefined) { sources[key] = "config"; return data[key]; }
		return fallback;
	};
	const hostPath = pick("hostPath", "code-mode-host", "");
	if (typeof hostPath !== "string") throw new Error("Code Mode Host path must be a string");
	const selected = pick("maxCells", "code-mode-max-cells", 1);
	const maxCells = capacity(sources.maxCells === "CLI" && typeof selected === "string" && /^[1-4]$/.test(selected) ? Number(selected) : selected);
	return { path, sources, value: {
		hostPath, protocol: protocolMode(pick("protocol", "code-mode-protocol", "json")),
		visibility: visibilityMode(pick("visibility", "code-mode-visibility", "mixed")),
		maxCells,
	} };
}
