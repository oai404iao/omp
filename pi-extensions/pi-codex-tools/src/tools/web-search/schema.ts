export interface SearchQuery {
	q: string;
	recency?: number;
	domains?: string[];
}

export interface WebSearchInput {
	search_query?: SearchQuery[];
	image_query?: SearchQuery[];
	open?: Array<{ ref_id: string; lineno?: number }>;
	click?: Array<{ ref_id: string; id: number }>;
	find?: Array<{ ref_id: string; pattern: string }>;
	screenshot?: Array<{ ref_id: string; pageno: number }>;
	finance?: Array<{
		ticker: string;
		type: "equity" | "fund" | "crypto" | "index";
		market?: string;
	}>;
	weather?: Array<{ location: string; start?: string; duration?: number }>;
	sports?: Array<{
		tool?: "sports";
		fn: "schedule" | "standings";
		league: "nba" | "wnba" | "nfl" | "nhl" | "mlb" | "epl" | "ncaamb" | "ncaawb" | "ipl";
		team?: string;
		opponent?: string;
		date_from?: string;
		date_to?: string;
		num_games?: number;
		locale?: string;
	}>;
	time?: Array<{ utc_offset: string }>;
	response_length?: "short" | "medium" | "long";
}

const searchQuerySchema = {
	type: "object",
	additionalProperties: false,
	required: ["q"],
	properties: {
		q: { type: "string", minLength: 1, description: "Search query." },
		recency: { type: "integer", minimum: 0, description: "Restrict results to this many recent days." },
		domains: { type: "array", items: { type: "string", minLength: 1 }, description: "Restrict results to these domains." },
	},
};

export const webSearchToolSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		search_query: {
			type: "array",
			maxItems: 4,
			items: searchQuerySchema,
			description: "Query the internet search engine.",
		},
		image_query: {
			type: "array",
			maxItems: 2,
			items: searchQuerySchema,
			description: "Query the image search engine.",
		},
		open: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["ref_id"],
				properties: {
					ref_id: { type: "string" },
					lineno: { type: "integer", minimum: 0 },
				},
			},
		},
		click: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["ref_id", "id"],
				properties: {
					ref_id: { type: "string" },
					id: { type: "integer", minimum: 0 },
				},
			},
		},
		find: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["ref_id", "pattern"],
				properties: {
					ref_id: { type: "string" },
					pattern: { type: "string" },
				},
			},
		},
		screenshot: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["ref_id", "pageno"],
				properties: {
					ref_id: { type: "string" },
					pageno: { type: "integer", minimum: 0 },
				},
			},
		},
		finance: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["ticker", "type"],
				properties: {
					ticker: { type: "string" },
					type: { type: "string", enum: ["equity", "fund", "crypto", "index"] },
					market: { type: "string" },
				},
			},
		},
		weather: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["location"],
				properties: {
					location: { type: "string" },
					start: { type: "string" },
					duration: { type: "integer", minimum: 1 },
				},
			},
		},
		sports: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["fn", "league"],
				properties: {
					tool: { type: "string", enum: ["sports"] },
					fn: { type: "string", enum: ["schedule", "standings"] },
					league: { type: "string", enum: ["nba", "wnba", "nfl", "nhl", "mlb", "epl", "ncaamb", "ncaawb", "ipl"] },
					team: { type: "string" },
					opponent: { type: "string" },
					date_from: { type: "string" },
					date_to: { type: "string" },
					num_games: { type: "integer", minimum: 1 },
					locale: { type: "string" },
				},
			},
		},
		time: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["utc_offset"],
				properties: {
					utc_offset: { type: "string" },
				},
			},
		},
		response_length: {
			type: "string",
			enum: ["short", "medium", "long"],
		},
	},
};
