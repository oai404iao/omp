export type WebSearchInput = Record<string, never>;

export const webSearchToolSchema = {
	type: "object",
	additionalProperties: false,
	properties: {},
};

export function createWebSearchToolDefinition() {
	return {
		name: "web_search",
		label: "Web Search",
		description: "Search the web with OpenAI's hosted Responses web_search tool on openai/gpt-5 models or explicitly configured additional model ids. This local placeholder is rewritten to the hosted tool before the provider request.",
		promptSnippet: "Search the web with the hosted OpenAI web_search tool when current information or citations are needed.",
		promptGuidelines: ["Use web_search when current web information or cited sources are needed."],
		parameters: webSearchToolSchema,
		async execute() {
			return {
				content: [{ type: "text", text: "web_search is native-provider-first. This package does not perform direct network search; use an openai/gpt-5 model or configure its full provider/model id in additionalModelIds, with nativeProviderTools and webSearchEnabled enabled." }],
				details: { phase: "native-provider", nativeTool: "web_search" },
			};
		},
	};
}
