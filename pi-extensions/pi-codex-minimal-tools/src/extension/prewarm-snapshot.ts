import { type Context, type ThinkingLevel } from "@earendil-works/pi-ai/compat";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { thinkingLevelFromUnknown } from "../providers/openai-codex/reasoning.js";

export interface StartupPrewarmSnapshot {
	systemPrompt: string;
	tools: Context["tools"];
	reasoning?: ThinkingLevel;
}

export function startupPrewarmSnapshot(pi: ExtensionAPI, ctx: any): StartupPrewarmSnapshot {
	const activeToolNames = typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [];
	return {
		systemPrompt: ctx.getSystemPrompt?.() ?? "",
		tools: (typeof pi.getAllTools === "function" ? pi.getAllTools() : [])
			.filter((tool) => activeToolNames.includes(tool.name))
			.map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			})),
		reasoning: thinkingLevelFromUnknown(
			(ctx as { thinkingLevel?: unknown }).thinkingLevel
			?? (typeof pi.getThinkingLevel === "function" ? pi.getThinkingLevel() : undefined),
		),
	};
}
