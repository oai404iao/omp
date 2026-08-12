export type CodexReservedToolName = "web_search" | "image_generation";

export interface CodexReservedNamespaceTool {
	type: "namespace";
	name: "web" | "image_gen";
	description: string;
	tools: Array<{
		type: "function";
		name: "run" | "imagegen";
		description: string;
		strict: false;
		parameters: Record<string, unknown>;
	}>;
}

// Captured from the Responses Lite `additional_tools` emitted by
// `/usr/bin/codex 0.146.0` for `gpt-5.6-sol` (Codex eb9dceba).
const CODEX_RESERVED_NAMESPACE_TOOLS: Record<CodexReservedToolName, CodexReservedNamespaceTool> = {
	web_search: {
		type: "namespace",
		name: "web",
		description: "Tools in the web namespace.",
		tools: [
			{
				type: "function",
				name: "run",
				description: "Tool for accessing the internet.\n\n\n---\n\n## Examples of different commands available in this tool\n\nExamples of different commands available in this tool:\n* `search_query`: {\"search_query\": [{\"q\": \"What is the capital of France?\"}, {\"q\": \"What is the capital of belgium?\"}]}. Searches the internet for a given query (and optionally with a domain or recency filter)\n* `image_query`: {\"image_query\":[{\"q\": \"waterfalls\"}]}.\n* `open`: {\"open\": [{\"ref_id\": \"turn0search0\"}, {\"ref_id\": \"https://www.openai.com\", \"lineno\": 120}]}\n* `click`: {\"click\": [{\"ref_id\": \"turn0fetch3\", \"id\": 17}]}\n* `find`: {\"find\": [{\"ref_id\": \"turn0fetch3\", \"pattern\": \"Annie Case\"}]}\n* `screenshot`: {\"screenshot\": [{\"ref_id\": \"turn1view0\", \"pageno\": 0}, {\"ref_id\": \"turn1view0\", \"pageno\": 3}]}\n* `finance`: {\"finance\":[{\"ticker\":\"AMD\",\"type\":\"equity\",\"market\":\"USA\"}]}, {\"finance\":[{\"ticker\":\"BTC\",\"type\":\"crypto\",\"market\":\"\"}]}\n* `weather`: {\"weather\":[{\"location\":\"San Francisco, CA\"}]}\n* `sports`: {\"sports\":[{\"fn\":\"standings\",\"league\":\"nfl\"}, {\"fn\":\"schedule\",\"league\":\"nba\",\"team\":\"GSW\",\"date_from\":\"2025-02-24\"}]}\n* `time`: {\"time\":[{\"utc_offset\":\"+03:00\"}]}\n\n---\n\n## Usage hints\nTo use this tool efficiently:\n* Use multiple commands and queries in one call to get more results faster; e.g. {\"search_query\": [{\"q\": \"bitcoin news\"}], \"finance\":[{\"ticker\":\"BTC\",\"type\":\"crypto\",\"market\":\"\"}], \"find\": [{\"ref_id\": \"turn0search0\", \"pattern\": \"Annie Case\"}, {\"ref_id\": \"turn0search1\", \"pattern\": \"John Smith\"}]}\n* Use \"response_length\" to control the number of results returned by this tool, omit it if you intend to pass \"short\" in\n* Only write required parameters; do not write empty lists or nulls where they could be omitted.\n* `search_query` must have length at most 4 in each call. If it has length > 3, response_length must be medium or long\n* If you find yourself in a situation where you accidentally call the `web.run` tool, it's best just to send an empty query: {\"search_query\": [{\"q\": \"\"}]}.\n\n---\n\n## Decision boundary\n\nIf the user makes an explicit request to search the internet, find latest information, look up, etc (or to not do so), you must obey their request.\nWhen you make an assumption, always consider whether it is temporally stable; i.e. whether there's even a small (>10%) chance it has changed. If it is unstable, you must verify with browsing the internet for verification.\n\n<situations_where_you_must_browse_the_internet>\nBelow is a list of scenarios where browsing the internet MUST be used. PAY CLOSE ATTENTION: you MUST browse the internet in these cases. If you're unsure or on the fence, you MUST bias towards browsing the internet.\n- The information could have changed recently: for example news; prices; laws; schedules; product specs; sports scores; economic indicators; political/public/company figures (e.g. the question relates to 'the president of country A' or 'the CEO of company B', which might change over time); rules; regulations; standards; software libraries that could be updated; exchange rates; recommendations (i.e., recommendations about various topics or things might be informed by what currently exists / is popular / is safe / is unsafe / is in the zeitgeist / etc.); and many many many more categories -- again, if you're on the fence, you MUST browse the internet!\n  - For news queries, prioritize more recent events, ensuring you compare publish dates and the date that the event happened.\n- The user is seeking recommendations that could lead them to spend substantial time or money -- researching products, restaurants, travel plans, etc.\n- The user wants (or would benefit from) direct quotes, links, or precise source attribution.\n- A specific page, paper, dataset, PDF, or site is referenced and you haven't been given its contents.\n- You're unsure about a fact, the topic is niche or emerging, or you suspect there's at least a 10% chance you will incorrectly recall it\n- High-stakes accuracy matters (medical, legal, financial guidance). For these you generally should search by default because this information is highly temporally unstable\n- The user explicitly says to search, browse, verify, or look it up.\n</situations_where_you_must_browse_the_internet>\n\n---\n\n## Citations\n\nResults from `web.run` include internal reference IDs such as `turn2search5`. Use\nthose reference IDs only in calls to `web.run`; do not expose them in the final\nresponse.\n\nCite sources in the final response using Markdown links:\n\n- Cite a single source as `[descriptive source title](https://example.com/page)`.\n- Cite multiple sources with separate Markdown links, for example\n  `[first source](https://example.com/one), [second source](https://example.com/two)`.\n- Link directly to the page that supports the claim. Do not link to search result\n  pages or use bare URLs.\n\nFormatting of citations:\n\n- Place each citation as near as possible to the claim it supports, normally at\n  the end of the sentence or paragraph and after punctuation.\n- Do not place citations inside code fences.\n- Do not put citations on a line by themselves or collect all citations at the\n  end of the response.\n\nIf you browse the internet, cite statements supported by web sources. Each cited\nsource must directly support the associated claim. Prefer primary and\nauthoritative sources, and use sources from different domains when the response\nbenefits from multiple perspectives.\n\n---\n\n## Special cases\nIf these conflict with any other instructions, these should take precedence.\n\n<special_cases>\n- When the user asks for information about how to use OpenAI products, (ChatGPT, the OpenAI API, etc.), you should check the code in local env and only browse as fallback, when you browse restrict your sources to official OpenAI websites using the domains filter, unless otherwise requested.\n- When using search to answer technical questions, you must only rely on primary sources (research papers, official documentation, etc.)\n- Clearly indicate when you are making an inference from sources.\n</special_cases>\n\n---\n\n## Word limits\nResponses may not excessively quote or draw on a specific source. There are several limits here:\n- **Limit on verbatim quotes:**\n  - You may not quote more than 25 words verbatim from any single non-lyrical source, unless the source is reddit.\n  - For song lyrics, verbatim quotes must be limited to at most 10 words.\n  - Long quotes from reddit are allowed, as long as you indicate that those are direct quotes via a markdown blockquote starting with \">\", copy verbatim, and link the source.\n- **Word limits:**\n  - Each webpage source in the sources has a word limit label formatted like \"[wordlim N]\", in which N is the maximum number of words in the whole response that are attributed to that source. If omitted, the word limit is 200 words.\n  - Non-contiguous words derived from a given source must be counted to the word limit.\n  - The summarization limit N is a maximum for each source.\n  - When using multiple sources, their summarization limits add together. However, each article used must be relevant to the response.\n- **Copyright compliance:**\n  - You must avoid providing full articles, long verbatim passages, or extensive direct quotes due to copyright concerns.\n  - If the user asked for a verbatim quote, the response should provide a short compliant excerpt and then answer with paraphrases and summaries.\n  - Again, this limit does not apply to reddit content, as long as it's appropriately indicated that those are direct quotes and you link to the source.\n",
				strict: false,
				parameters: {
					type: "object",
					properties: {
						click: {
							type: "array",
							description: "Open links from previously opened pages.",
							items: {
								type: "object",
								properties: {
									id: {
										type: "integer",
										description: "Numbered link id to open.",
									},
									ref_id: {
										type: "string",
										description: "Reference id containing the numbered link.",
									},
								},
								required: ["id", "ref_id"],
							},
						},
						finance: {
							type: "array",
							description: "Look up prices for the given stock symbols.",
							items: {
								type: "object",
								properties: {
									market: {
										type: "string",
										description: "ISO 3166-1 alpha-3 country code, \"OTC\", or \"\" for cryptocurrency.",
									},
									ticker: {
										type: "string",
										description: "Ticker symbol to look up.",
									},
									type: {
										type: "string",
										description: "Asset type to look up.",
										enum: ["equity", "fund", "crypto", "index"],
									},
								},
								required: ["ticker", "type"],
							},
						},
						find: {
							type: "array",
							description: "Find text patterns in pages.",
							items: {
								type: "object",
								properties: {
									pattern: {
										type: "string",
										description: "Text pattern to find.",
									},
									ref_id: {
										type: "string",
										description: "Reference id or URL to search within.",
									},
								},
								required: ["pattern", "ref_id"],
							},
						},
						image_query: {
							type: "array",
							description: "Query the image search engine for a given list of queries.",
							items: {
								type: "object",
								properties: {
									domains: {
										type: "array",
										description: "Whether to filter by a specific list of domains.",
										items: { type: "string" },
									},
									q: {
										type: "string",
										description: "Search query.",
									},
									recency: {
										type: "integer",
										description: "Whether to filter by recency, as a number of recent days.",
									},
								},
								required: ["q"],
							},
						},
						open: {
							type: "array",
							description: "Open pages by reference id or URL.",
							items: {
								type: "object",
								properties: {
									lineno: {
										type: "integer",
										description: "Line number to position the page at.",
									},
									ref_id: {
										type: "string",
										description: "Reference id or URL to open.",
									},
								},
								required: ["ref_id"],
							},
						},
						response_length: {
							type: "string",
							description: "Set the length of the response to be returned.",
							enum: ["short", "medium", "long"],
						},
						screenshot: {
							type: "array",
							description: "Take screenshots of PDF pages.",
							items: {
								type: "object",
								properties: {
									pageno: {
										type: "integer",
										description: "Zero-indexed PDF page number.",
									},
									ref_id: {
										type: "string",
										description: "Reference id or URL to screenshot.",
									},
								},
								required: ["pageno", "ref_id"],
							},
						},
						search_query: {
							type: "array",
							description: "Query the internet search engine for a given list of queries.",
							items: {
								type: "object",
								properties: {
									domains: {
										type: "array",
										description: "Whether to filter by a specific list of domains.",
										items: { type: "string" },
									},
									q: {
										type: "string",
										description: "Search query.",
									},
									recency: {
										type: "integer",
										description: "Whether to filter by recency, as a number of recent days.",
									},
								},
								required: ["q"],
							},
						},
						sports: {
							type: "array",
							description: "Look up sports schedules and standings.",
							items: {
								type: "object",
								properties: {
									date_from: {
										type: "string",
										description: "Start date in YYYY-MM-DD format.",
									},
									date_to: {
										type: "string",
										description: "End date in YYYY-MM-DD format.",
									},
									fn: {
										type: "string",
										description: "Sports function to call.",
										enum: ["schedule", "standings"],
									},
									league: {
										type: "string",
										description: "League to look up.",
										enum: ["nba", "wnba", "nfl", "nhl", "mlb", "epl", "ncaamb", "ncaawb", "ipl"],
									},
									locale: {
										type: "string",
										description: "Locale for the lookup.",
									},
									num_games: {
										type: "integer",
										description: "Number of games to return.",
									},
									opponent: {
										type: "string",
										description: "Opponent to use with `team` when narrowing the lookup.",
									},
									team: {
										type: "string",
										description: "Team to look up, using the common 3 or 4 letter alias used in broadcasts.",
									},
									tool: {
										type: "string",
										description: "Tool name for sports requests.",
										enum: ["sports"],
									},
								},
								required: ["fn", "league"],
							},
						},
						time: {
							type: "array",
							description: "Get time for the given UTC offsets.",
							items: {
								type: "object",
								properties: {
									utc_offset: {
										type: "string",
										description: "UTC offset formatted like \"+03:00\".",
									},
								},
								required: ["utc_offset"],
							},
						},
						weather: {
							type: "array",
							description: "Look up weather forecasts.",
							items: {
								type: "object",
								properties: {
									duration: {
										type: "integer",
										description: "Number of days to return. Defaults to 7.",
									},
									location: {
										type: "string",
										description: "Location in \"Country, Area, City\" format.",
									},
									start: {
										type: "string",
										description: "Start date in YYYY-MM-DD format. Defaults to today.",
									},
								},
								required: ["location"],
							},
						},
					},
				},
			},
		],
	},
	image_generation: {
		type: "namespace",
		name: "image_gen",
		description: "Tools in the image_gen namespace.",
		tools: [
			{
				type: "function",
				name: "imagegen",
				description: "The `image_gen.imagegen` tool enables image generation from descriptions and editing of existing images based on specific instructions. Use it when:\n\n- The user requests an image based on a scene description, such as a diagram, portrait, comic, meme, or any other visual.\n- The user wants to modify an attached or previously generated image with specific changes, including adding or removing elements, altering colors, improving quality/resolution, or transforming the style (e.g., cartoon, oil painting).\n\nGuidelines:\n- imagegen needs a few minutes to finish. In code-mode, use the first-line @exec directive to give the initial call 120 seconds and the same yield for any waits that follow. Once it finishes, return the image with generatedImage(result).\n- Omit both `referenced_image_paths` and `num_last_images_to_include` when generating a brand new image.\n- For edits, use `referenced_image_paths` when every target image has a local file path.\n- If you have not seen a local image yet, use `view_image` to inspect it before editing.\n- Use `num_last_images_to_include` only when at least one target image has no local file path.\n- Set `num_last_images_to_include` to the smallest number of recent conversation images that includes every target image, up to 5.\n- Never provide both `referenced_image_paths` and `num_last_images_to_include`.\n- If neither mechanism can include every target image, ask the user to attach the missing images again.\n- Directly generate the image without reconfirmation or clarification unless required images must be attached again.\n- Always use this tool for image editing unless the user explicitly requests otherwise. Do not use the `python` tool for image editing unless specifically instructed.\n",
				strict: false,
				parameters: {
					type: "object",
					properties: {
						num_last_images_to_include: {
							type: ["integer", "null"],
						},
						prompt: {
							type: "string",
						},
						referenced_image_paths: {
							type: ["array", "null"],
							items: {
								type: "string",
								description: "A path that is guaranteed to be absolute and normalized (though it is not guaranteed to be canonicalized or exist on the filesystem).\n\nIMPORTANT: When deserializing an `AbsolutePathBuf`, a base path must be set using [AbsolutePathBufGuard::new]. If no base path is set, the deserialization will fail unless the path being deserialized is already absolute.",
							},
						},
					},
					required: ["prompt"],
					additionalProperties: false,
				},
			},
		],
	},
};

export function createCodexReservedNamespaceTool(
	name: CodexReservedToolName,
): CodexReservedNamespaceTool {
	return structuredClone(CODEX_RESERVED_NAMESPACE_TOOLS[name]);
}
