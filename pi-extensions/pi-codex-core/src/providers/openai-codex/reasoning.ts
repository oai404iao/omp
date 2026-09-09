import { type Api, type Model, type ThinkingLevel } from "@earendil-works/pi-ai/compat";

export function clampReasoningEffort(modelId: string, effort: string): string {
	const id = modelId.includes("/") ? (modelId.split("/").pop() ?? modelId) : modelId;
	const gpt5MinorMatch = /^gpt-5\.(\d+)/.exec(id);
	const gpt5Minor = gpt5MinorMatch ? Number.parseInt(gpt5MinorMatch[1], 10) : undefined;
	if (gpt5Minor !== undefined && gpt5Minor >= 2 && effort === "minimal") return "low";
	if (id === "gpt-5.1" && effort === "xhigh") return "high";
	if (id === "gpt-5.1-codex-mini") return effort === "high" || effort === "xhigh" ? "high" : "medium";
	return effort;
}

const CODEX_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

type CodexThinkingLevel = (typeof CODEX_THINKING_LEVELS)[number];

/**
 * Keep this local instead of delegating to older Pi releases: Pi added `max`
 * after this extension's original minimum version, and an old clamp silently
 * turns it into `off`.
 */
export function clampCodexThinkingLevel(model: Model<Api>, level: ThinkingLevel): CodexThinkingLevel {
	if (!model.reasoning) return "off";
	const available = CODEX_THINKING_LEVELS.filter((candidate) => {
		if (candidate === "off") return true;
		const mapped = (model.thinkingLevelMap as Record<string, string | null | undefined> | undefined)?.[candidate];
		if (mapped === null) return false;
		if (candidate === "xhigh" || candidate === "max") return mapped !== undefined;
		return true;
	});
	if (available.includes(level as CodexThinkingLevel)) return level as CodexThinkingLevel;
	const requestedIndex = CODEX_THINKING_LEVELS.indexOf(level as CodexThinkingLevel);
	if (requestedIndex < 0) return available[0] ?? "off";
	for (let index = requestedIndex; index < CODEX_THINKING_LEVELS.length; index++) {
		const candidate = CODEX_THINKING_LEVELS[index]!;
		if (available.includes(candidate)) return candidate;
	}
	for (let index = requestedIndex - 1; index >= 0; index--) {
		const candidate = CODEX_THINKING_LEVELS[index]!;
		if (available.includes(candidate)) return candidate;
	}
	return available[0] ?? "off";
}

export function thinkingLevelFromUnknown(value: unknown): ThinkingLevel | undefined {
	return value === "minimal"
		|| value === "low"
		|| value === "medium"
		|| value === "high"
		|| value === "xhigh"
		|| value === "max"
		? value
		: undefined;
}
