import type { ToolProtocol } from "@oai404iao/pi-codex-runtime/internal/broker";

export const patchToolProtocols = new Map<string, ToolProtocol>([["apply_patch", {
	customTool: { type: "custom", name: "apply_patch", description: "Neutral patch protocol fixture", format: { type: "text" } },
	inputProperty: "input", hiddenTools: ["edit", "write"],
}]]);

export function createApplyPatchToolDefinition(_options: { deferRendering?: boolean } = {}) {
	return {
		name: "apply_patch",
		description: "Neutral patch protocol fixture",
		parameters: {
			type: "object",
			properties: { input: { type: "string" } },
			required: ["input"],
		},
	};
}
