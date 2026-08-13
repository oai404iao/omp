import { buildSessionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	buildCodexJsonHeaders,
	hasCodexRequestAuth,
	resolveCodexApiEndpoint,
} from "../codex-http.js";
import { loadModelSettings } from "../model-catalog/runtime.js";

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

interface WebSearchToolContext {
	cwd: string;
	model?: Model<Api>;
	modelRegistry?: {
		getApiKeyAndHeaders(model: Model<Api>): Promise<
			| { ok: true; apiKey?: string; headers?: Record<string, string> }
			| { ok: false; error: string }
		>;
	};
	sessionManager?: {
		getSessionId(): string;
		getBranch?(): SessionEntry[];
	};
}

interface StandaloneSearchResponse {
	encrypted_output?: string | null;
	output?: string;
	results?: unknown[];
}

export interface StandaloneWebSearchInvocation {
	turnId?: string;
}

const CODEX_STANDALONE_SEARCH_OUTPUT_TOKEN_LIMIT = 10_000;
const SEARCH_OPERATION_KEYS = [
	"search_query",
	"image_query",
	"open",
	"click",
	"find",
	"screenshot",
	"finance",
	"weather",
	"sports",
	"time",
] as const;

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

function visibleMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((item): item is { type: "text"; text: string } =>
			Boolean(item)
			&& typeof item === "object"
			&& (item as { type?: unknown }).type === "text"
			&& typeof (item as { text?: unknown }).text === "string")
		.map((item) => item.text)
		.join("\n")
		.trim();
}

function recentSearchInput(ctx: WebSearchToolContext, turnId?: string): unknown[] | undefined {
	if (!ctx.sessionManager?.getBranch) return undefined;
	const visible: Array<{ role: "user" | "assistant"; text: string }> = [];
	for (const message of buildSessionContext(ctx.sessionManager.getBranch()).messages) {
		if (message.role !== "user" && message.role !== "assistant") continue;
		const text = visibleMessageText(message.content);
		if (!text || (message.role === "user" && /^<environment_context>[\s\S]*<\/environment_context>$/i.test(text))) {
			continue;
		}
		visible.push({ role: message.role, text });
	}
	const userIndexes = visible
		.map((message, index) => message.role === "user" ? index : -1)
		.filter((index) => index >= 0);
	const start = userIndexes.length > 1 ? userIndexes[userIndexes.length - 2]! : userIndexes[0] ?? 0;
	const tail = visible.slice(start);
	let currentUserIndex = -1;
	for (let index = 0; index < tail.length; index++) {
		if (tail[index]?.role === "user") currentUserIndex = index;
	}
	let assistantBudget = 4_000;
	return tail.map((message, index) => {
		let text = message.text;
		if (message.role === "assistant") {
			text = text.slice(0, Math.max(0, assistantBudget));
			assistantBudget -= text.length;
		}
		return {
			type: "message",
			role: message.role,
			content: [{
				type: message.role === "assistant" ? "output_text" : "input_text",
				text,
			}],
			...(turnId && index === currentUserIndex
				? { internal_chat_message_metadata_passthrough: { turn_id: turnId } }
				: {}),
		};
	}).filter((message) => message.content[0]!.text.length > 0);
}

function searchOperationLabel(input: WebSearchInput): string {
	const operations = SEARCH_OPERATION_KEYS.filter((key) => (input[key]?.length ?? 0) > 0);
	return operations.length > 0 ? operations.join(", ") : "commands";
}

function assertStandaloneSearchOutput(output: string, input: WebSearchInput): void {
	const normalized = output.trim();
	if (/^Found no tool response\b[\s\S]*arguments you provided were not valid\.?$/i.test(normalized)) {
		throw new Error(
			`Standalone web search backend returned no tool response for ${searchOperationLabel(input)}. `
			+ "The endpoint accepted the request but could not execute it; retry with search_query or another supported operation.",
		);
	}
	if (/^Error parsing function call\b/i.test(normalized)) {
		throw new Error(
			`Standalone web search backend rejected ${searchOperationLabel(input)}: ${normalized}`,
		);
	}
}

export async function standaloneWebSearch(
	input: WebSearchInput,
	ctx: WebSearchToolContext,
	signal?: AbortSignal,
	invocation: StandaloneWebSearchInvocation = {},
) {
	const model = ctx.model;
	if (!model || !ctx.modelRegistry) throw new Error("No active model is available for standalone web search.");
	const settings = loadModelSettings(model, ctx.cwd);
	if (!settings.enabled) throw new Error("pi-codex-minimal-tools is disabled.");
	if (settings.webSearchImplementation !== "standalone") {
		throw new Error(`Standalone web search is not enabled for ${model.provider}/${model.id}.`);
	}
	const contentTypes = settings.modelProfile?.effective.tools.webSearch
		? settings.modelProfile.effective.tools.webSearch.contentTypes ?? ["text"]
		: [];
	if (input.search_query?.length && !contentTypes.includes("text")) {
		throw new Error("Text search is disabled by the current model profile.");
	}
	if (input.image_query?.length && !contentTypes.includes("image")) {
		throw new Error("Image search is disabled by the current model profile.");
	}
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(auth.error);
	if (!hasCodexRequestAuth({
		modelHeaders: model.headers,
		auth: { apiKey: auth.apiKey, headers: auth.headers },
	})) {
		throw new Error(`No request authentication for provider: ${model.provider}`);
	}

	const url = resolveCodexApiEndpoint(model.baseUrl, settings.apiKeyMode, "alpha/search");
	const sessionId = ctx.sessionManager?.getSessionId();
	const searchInput = recentSearchInput(ctx, invocation.turnId);
	const turnMetadata = invocation.turnId
		? JSON.stringify({
				...(sessionId ? { session_id: sessionId, thread_id: sessionId } : {}),
				turn_id: invocation.turnId,
				model: model.id,
			})
		: undefined;
	const response = await fetch(url, {
		method: "POST",
		headers: buildCodexJsonHeaders({
			modelHeaders: model.headers,
			auth: { apiKey: auth.apiKey, headers: auth.headers },
			apiKeyMode: settings.apiKeyMode,
			...(turnMetadata
				? { extraHeaders: { "x-codex-turn-metadata": turnMetadata } }
				: {}),
		}),
		body: JSON.stringify({
			id: sessionId ?? `pi-search-${Date.now()}`,
			model: model.id,
			...(searchInput ? { input: searchInput } : {}),
			commands: input,
			settings: {
				allowed_callers: ["direct"],
				external_web_access: true,
			},
			max_output_tokens: CODEX_STANDALONE_SEARCH_OUTPUT_TOKEN_LIMIT,
		}),
		signal,
	});
	if (!response.ok) {
		throw new Error(`Standalone web search failed: HTTP ${response.status}: ${await response.text()}`);
	}
	const result = await response.json() as StandaloneSearchResponse;
	if (typeof result.output !== "string" || !result.output.trim()) {
		throw new Error("Standalone web search returned no output.");
	}
	assertStandaloneSearchOutput(result.output, input);
	return {
		content: [{ type: "text", text: result.output }],
		details: {
			mode: "standalone",
			results: result.results ?? [],
		},
	};
}

export function createWebSearchToolDefinition(options: {
	getCurrentTurnId?: (sessionId: string | undefined) => string | undefined;
} = {}) {
	return {
		name: "web_search",
		label: "Web Search",
		description: "Search the web using the implementation selected by the current model profile. Hosted profiles are rewritten into the OpenAI Responses web_search tool; standalone profiles call the Codex alpha/search endpoint.",
		promptSnippet: "Search the web when current information or citations are needed.",
		promptGuidelines: ["Use web_search when current web information or cited sources are needed."],
		parameters: webSearchToolSchema,
		async execute(
			_toolCallId: string,
			input: WebSearchInput,
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: WebSearchToolContext,
		) {
			const settings = loadModelSettings(ctx.model, ctx.cwd);
			if (settings.webSearchImplementation === "standalone") {
				const sessionId = ctx.sessionManager?.getSessionId();
				return standaloneWebSearch(input, ctx, signal, {
					turnId: options.getCurrentTurnId?.(sessionId),
				});
			}
			return {
				content: [{ type: "text", text: "web_search is hosted-provider-first for this model profile and should be rewritten before execution." }],
				details: { phase: "native-provider", nativeTool: "web_search" },
			};
		},
	};
}
