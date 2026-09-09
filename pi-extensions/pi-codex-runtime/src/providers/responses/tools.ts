import { type Tool } from "@earendil-works/pi-ai";
import { type Tool as OpenAITool } from "openai/resources/responses/responses.js";
import { type ConvertResponsesToolsOptions } from "./types.js";

export function convertResponsesTools(tools: Tool[], options?: ConvertResponsesToolsOptions): OpenAITool[] {
	const strict = options?.strict === undefined ? false : options.strict;
	return tools.map((tool) => ({
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters as unknown as Record<string, unknown>,
		strict,
	}));
}
