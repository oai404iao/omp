import { type Tool } from "@earendil-works/pi-ai";
import { type Tool as OpenAITool } from "openai/resources/responses/responses.js";
import { type ConvertResponsesToolsOptions } from "./types.js";
import { resolveGrammarSampling } from "./sampling.js";

export function convertResponsesTools(tools: Tool[], options?: ConvertResponsesToolsOptions): OpenAITool[] {
	const strict = options?.strict === undefined ? false : options.strict;
	return tools.map((tool) => {
		const grammar = resolveGrammarSampling(tool, options?.supportsOpenAIGrammarTools === true);
		if (grammar) return {
			type: "custom", name: tool.name, description: tool.description,
			format: { type: "grammar", syntax: grammar.format, definition: grammar.definition },
		};
		return {
			type: "function", name: tool.name, description: tool.description,
			parameters: tool.parameters as unknown as Record<string, unknown>, strict,
		};
	});
}
