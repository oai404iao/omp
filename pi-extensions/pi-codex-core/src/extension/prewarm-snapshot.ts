import { type Context, type ThinkingLevel } from "@earendil-works/pi-ai/compat";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { thinkingLevelFromUnknown } from "../providers/openai-codex/reasoning.js";
import { activeToolSnapshot } from "./tool-snapshot.js";

export interface StartupPrewarmSnapshot {
	systemPrompt: string;
	tools: Context["tools"];
	reasoning?: ThinkingLevel;
}

export function startupPrewarmSnapshot(pi: ExtensionAPI, ctx: any): StartupPrewarmSnapshot {
	return {
		systemPrompt: ctx.getSystemPrompt?.() ?? "",
		tools: activeToolSnapshot(pi),
		reasoning: thinkingLevelFromUnknown(
			(ctx as { thinkingLevel?: unknown }).thinkingLevel
			?? (typeof pi.getThinkingLevel === "function" ? pi.getThinkingLevel() : undefined),
		),
	};
}
