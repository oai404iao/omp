import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { assertSupportedToolReferences } from "./tool-policy.ts";
import type { AgentDefinition, AgentScope, AgentSource } from "./types.ts";

const MAX_AGENT_FILE_BYTES = 256 * 1024;
const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export interface AgentDiscoveryOptions {
	cwd: string;
	scope: AgentScope;
	projectTrusted: boolean;
	bundledDir: string;
	agentDir?: string;
	includeBundled?: boolean;
	excludeUserAgentNames?: ReadonlySet<string>;
}

export interface AgentDiscoveryResult {
	agents: AgentDefinition[];
	diagnostics: string[];
	projectAgentsDir?: string;
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | undefined {
	let current = resolve(cwd);
	while (true) {
		const candidate = join(current, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseTools(value: unknown, filePath: string): string[] | undefined {
	const raw = optionalString(value);
	if (!raw || raw === "*" || raw.toLowerCase() === "all") return undefined;
	if (raw.toLowerCase() === "none") return [];
	const tools = [...new Set(raw.split(",").map((tool) => tool.trim()).filter(Boolean))];
	if (tools.length === 0) throw new Error(`${filePath}: tools must name at least one tool, "all", or "none"`);
	assertSupportedToolReferences(tools, `${filePath}: tools`);
	return tools;
}

function parseThinking(value: unknown, filePath: string): ThinkingLevel | undefined {
	const thinking = optionalString(value);
	if (!thinking) return undefined;
	if (!THINKING_LEVELS.has(thinking as ThinkingLevel)) {
		throw new Error(`${filePath}: unsupported thinking level "${thinking}"`);
	}
	return thinking as ThinkingLevel;
}

function loadAgentFile(filePath: string, source: AgentSource): AgentDefinition {
	const stats = statSync(filePath);
	if (stats.size > MAX_AGENT_FILE_BYTES) {
		throw new Error(`${filePath}: agent definition exceeds ${MAX_AGENT_FILE_BYTES} bytes`);
	}
	const content = readFileSync(filePath, "utf8");
	const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
	const name = optionalString(frontmatter.name);
	const description = optionalString(frontmatter.description);
	if (!name || !AGENT_NAME_PATTERN.test(name)) {
		throw new Error(`${filePath}: name must match ${AGENT_NAME_PATTERN}`);
	}
	if (!description) throw new Error(`${filePath}: description is required`);
	if (!body.trim()) throw new Error(`${filePath}: agent system prompt is empty`);

	return {
		name,
		description,
		tools: parseTools(frontmatter.tools, filePath),
		model: optionalString(frontmatter.model),
		thinking: parseThinking(frontmatter.thinking, filePath),
		systemPrompt: body.trim(),
		source,
		filePath,
	};
}

function loadDirectory(
	dir: string,
	source: AgentSource,
	excludeNames?: ReadonlySet<string>,
): { agents: AgentDefinition[]; diagnostics: string[] } {
	if (!isDirectory(dir)) return { agents: [], diagnostics: [] };
	const agents: AgentDefinition[] = [];
	const diagnostics: string[] = [];
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		return {
			agents,
			diagnostics: [`${dir}: ${error instanceof Error ? error.message : String(error)}`],
		};
	}

	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
		if (excludeNames?.has(entry.name)) continue;
		const filePath = join(dir, entry.name);
		try {
			agents.push(loadAgentFile(filePath, source));
		} catch (error) {
			diagnostics.push(error instanceof Error ? error.message : String(error));
		}
	}
	return { agents, diagnostics };
}

export function discoverAgents(options: AgentDiscoveryOptions): AgentDiscoveryResult {
	const projectAgentsDir =
		options.scope !== "user" && options.projectTrusted
			? findNearestProjectAgentsDir(options.cwd)
			: undefined;
	const sources: Array<{ dir: string; source: AgentSource }> = [];
	if (options.includeBundled !== false) {
		sources.push({ dir: options.bundledDir, source: "bundled" });
	}
	if (options.scope !== "project") {
		sources.push({ dir: join(options.agentDir ?? getAgentDir(), "agents"), source: "user" });
	}
	if (options.scope !== "user" && options.projectTrusted && projectAgentsDir) {
		sources.push({ dir: projectAgentsDir, source: "project" });
	}

	const diagnostics: string[] = [];
	if (options.scope !== "user" && !options.projectTrusted) {
		diagnostics.push("Project-local agents were not loaded because the project is not trusted.");
	}

	const byName = new Map<string, AgentDefinition>();
	for (const item of sources) {
		const loaded = loadDirectory(
			item.dir,
			item.source,
			item.source === "user" ? options.excludeUserAgentNames : undefined,
		);
		diagnostics.push(...loaded.diagnostics);
		for (const agent of loaded.agents) byName.set(agent.name, agent);
	}

	return {
		agents: [...byName.values()],
		diagnostics,
		...(projectAgentsDir ? { projectAgentsDir } : {}),
	};
}

export function formatAgentCatalog(agents: AgentDefinition[]): string {
	if (agents.length === 0) return "(no agents)";
	return agents.map((agent) => `${agent.name} (${agent.source}) — ${agent.description}`).join("\n");
}

export function hasBundledAgents(dir: string): boolean {
	return existsSync(dir) && isDirectory(dir);
}
