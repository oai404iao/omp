import { webSearchToolSchema, type WebSearchInput } from "./web-search/schema.js";
import { webSearchOutputSchema } from "./web-search/output.js";
import { recentSearchInput } from "./web-search/history.js";
export { webSearchToolSchema } from "./web-search/schema.js";
export type { SearchQuery, WebSearchInput } from "./web-search/schema.js";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel, type Api, type Model, type ProviderHeaders, type ThinkingLevel } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import {
	buildCodexJsonHeaders,
	hasCodexRequestAuth,
	resolveCodexApiEndpoint,
	withResolvedAuthBaseUrl,
} from "@oai404iao/pi-codex-runtime/internal/codex-http";
import { glyphs, truncateText } from "@oai404iao/pi-codex-runtime/internal/glyphs";
import { applyEndpointPolicy, loadModelSettings } from "@oai404iao/pi-codex-runtime/internal/model-catalog/runtime";
import { checkEndpointResponse, rememberResolvedEndpoint } from "@oai404iao/pi-codex-runtime/internal/endpoint-state";
import { buildCodexExternalToolMetadataJson } from "@oai404iao/pi-codex-runtime/internal/codex-metadata";
import { fetchCodexJson } from "@oai404iao/pi-codex-runtime/internal/json-request";
import {
	resolveCodexRequestIdentity,
	type CodexRequestIdentity,
} from "@oai404iao/pi-codex-runtime/internal/codex-wire-identity";

interface WebSearchToolContext {
	cwd: string;
	model?: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	modelRegistry?: {
		getApiKeyAndHeaders(model: Model<Api>): Promise<
			| { ok: true; apiKey?: string; headers?: ProviderHeaders; baseUrl?: string }
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

export interface StandaloneWebSearchResult {
	type?: string;
	domain?: string;
	ref_id?: string;
	snippet?: string;
	title?: string;
	url?: string;
}

export interface StandaloneWebSearchDetails {
	mode: "standalone";
	results: StandaloneWebSearchResult[];
}

export interface StandaloneWebSearchInvocation {
	turnId?: string;
	identity?: CodexRequestIdentity;
}

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

function searchInputSummary(input: WebSearchInput): string {
	const queries = [
		...(input.search_query ?? []).map((query) => query.q),
		...(input.image_query ?? []).map((query) => query.q),
	].map((query) => query.trim()).filter(Boolean);
	if (queries.length > 0) {
		return queries.length > 1 ? `${queries[0]} +${queries.length - 1}` : queries[0]!;
	}
	const open = input.open?.[0]?.ref_id?.trim();
	if (open) return open;
	const find = input.find?.[0];
	if (find?.pattern?.trim()) return find.pattern.trim();
	const weather = input.weather?.[0]?.location?.trim();
	if (weather) return weather;
	const finance = input.finance?.[0]?.ticker?.trim();
	if (finance) return finance;
	const sports = input.sports?.[0];
	if (sports) return [sports.league, sports.team, sports.fn].filter(Boolean).join(" ");
	const time = input.time?.[0]?.utc_offset?.trim();
	if (time) return time;
	return searchOperationLabel(input);
}

function resultHost(result: StandaloneWebSearchResult): string | undefined {
	const domain = result.domain?.trim().replace(/^www\./i, "");
	if (domain) return domain;
	if (!result.url) return undefined;
	try {
		return new URL(result.url).hostname.replace(/^www\./i, "") || undefined;
	} catch {
		return undefined;
	}
}

export function standaloneWebSearchHosts(results: readonly StandaloneWebSearchResult[]): string[] {
	const seen = new Set<string>();
	const hosts: string[] = [];
	for (const result of results) {
		const host = resultHost(result);
		const key = host?.toLowerCase();
		if (!host || !key || seen.has(key)) continue;
		seen.add(key);
		hosts.push(host);
	}
	return hosts;
}

function renderHostTags(
	results: readonly StandaloneWebSearchResult[],
	theme: any,
	cwd?: string,
): string {
	const hosts = standaloneWebSearchHosts(results);
	if (hosts.length === 0) return "";
	const shown = hosts.slice(0, 8);
	const separator = theme.fg("dim", glyphs(cwd).dot);
	const tags = shown.map((host) => theme.fg("accent", host));
	if (hosts.length > shown.length) tags.push(theme.fg("dim", `+${hosts.length - shown.length}`));
	return tags.join(separator);
}

function renderStandaloneWebSearchCall(input: WebSearchInput, theme: any, cwd?: string): Text {
	const summary = truncateText(searchInputSummary(input), 96, cwd);
	const text = `${theme.fg("accent", glyphs(cwd).bullet)}`
		+ theme.fg("text", theme.bold("Web Search"))
		+ (summary ? theme.fg("dim", ` ${summary}`) : "");
	return new Text(text, 0, 0);
}

function renderStandaloneWebSearchResult(
	result: { content?: Array<{ type?: string; text?: string }>; details?: StandaloneWebSearchDetails },
	options: { expanded?: boolean; isPartial?: boolean },
	theme: any,
	context: { cwd?: string; isError?: boolean },
): Text {
	if (options.isPartial) return new Text("", 0, 0);
	const text = result.content
		?.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n") ?? "";
	if (context.isError) return new Text(theme.fg("error", text || "Web search failed"), 0, 0);

	const results = result.details?.mode === "standalone" ? result.details.results : [];
	const hosts = renderHostTags(results, theme, context.cwd);
	const count = results.length;
	let rendered = count > 0 ? `${hosts ? `${hosts} ` : ""}${theme.fg("dim", `(${count})`)}` : theme.fg("muted", "Search complete");
	if (options.expanded && text) rendered += `\n\n${theme.fg("toolOutput", text)}`;
	return new Text(rendered, 0, 0);
}

export async function standaloneWebSearch(
	input: WebSearchInput,
	ctx: WebSearchToolContext,
	signal?: AbortSignal,
	invocation: StandaloneWebSearchInvocation = {},
) {
	signal?.throwIfAborted();
	const model = ctx.model;
	if (!model || !ctx.modelRegistry) throw new Error("No active model is available for standalone web search.");
	let settings = loadModelSettings({ ...model, baseUrl: undefined }, ctx.cwd);
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
	const piSessionId = ctx.sessionManager?.getSessionId();
	const identity = !settings.codexRequestExtensions ? undefined : invocation.identity
		?? resolveCodexRequestIdentity(
			piSessionId,
			invocation.turnId ? { turn_id: invocation.turnId } : undefined,
			"turn",
		);
	const turnId = identity?.turnId || invocation.turnId;
	const searchInput = ctx.sessionManager?.getBranch
		? recentSearchInput(ctx.sessionManager.getBranch(), turnId) : undefined;
	const thinkingLevel = ctx.thinkingLevel === undefined ? undefined : clampThinkingLevel(model, ctx.thinkingLevel);
	const mappedEffort = thinkingLevel === undefined ? undefined : model.thinkingLevelMap?.[thinkingLevel];
	const reasoningEffort = mappedEffort === null ? undefined
		: mappedEffort ?? (thinkingLevel === "off" ? undefined : thinkingLevel);
	const turnMetadata = identity && turnId
		? buildCodexExternalToolMetadataJson({ ...identity, model: model.id, ...(reasoningEffort ? { reasoningEffort } : {}) })
		: undefined;
	const searchProfile = settings.modelProfile?.effective.tools.webSearch || undefined;
	const requestBody = JSON.stringify({
		id: identity?.sessionId ?? piSessionId ?? `pi-search-${Date.now()}`,
		model: model.id,
		...(searchInput ? { input: searchInput } : {}),
		commands: input,
		settings: {
			allowed_callers: ["direct"],
			external_web_access: searchProfile?.mode === "cached" ? false : searchProfile?.mode === "indexed" ? "indexed" : true,
			...(searchProfile?.searchContextSize ? { search_context_size: searchProfile.searchContextSize } : {}),
			...(searchProfile?.userLocation ? { user_location: searchProfile.userLocation } : {}),
			...(searchProfile?.filters?.allowedDomains ? { filters: { allowed_domains: searchProfile.filters.allowedDomains } } : {}),
		},
		max_output_tokens: searchProfile?.maxOutputTokens ?? 10_000,
	});
	// A nested cell may survive a user-turn rollover while auth is pending.
	// Identity and visible history must describe this invocation, not that later turn.
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	signal?.throwIfAborted();
	if (!auth.ok) throw new Error(auth.error);
	const requestModel = withResolvedAuthBaseUrl(model, auth);
	rememberResolvedEndpoint(model, requestModel, piSessionId);
	settings = applyEndpointPolicy(settings, requestModel, piSessionId);
	if (settings.webSearchImplementation !== "standalone") throw new Error("Standalone web search is disabled for this endpoint.");
	const url = resolveCodexApiEndpoint(auth.baseUrl ?? model.baseUrl, settings.responsesEndpoint, "alpha/search");
	if (!hasCodexRequestAuth({ modelHeaders: model.headers, auth: { apiKey: auth.apiKey, headers: auth.headers } })) {
		throw new Error(`No request authentication for provider: ${model.provider}`);
	}
	const response = await fetchCodexJson(url, {
		headers: buildCodexJsonHeaders({
			codexRequestExtensions: settings.codexRequestExtensions,
			modelHeaders: model.headers,
			auth: { apiKey: auth.apiKey, headers: auth.headers },
			endpoint: settings.responsesEndpoint,
			...(turnMetadata
				? { extraHeaders: { "x-codex-turn-metadata": turnMetadata } }
				: {}),
		}),
		body: requestBody,
		signal,
	}, ["webSearch.standalone"]);
	await checkEndpointResponse(response, requestModel, piSessionId, ["webSearch.standalone"], signal);
	const result = await response.json() as StandaloneSearchResponse;
	signal?.throwIfAborted();
	if (typeof result.output !== "string" || !result.output.trim()) {
		throw new Error("Standalone web search returned no output.");
	}
	assertStandaloneSearchOutput(result.output, input);
	if (result.results !== undefined && !Array.isArray(result.results)) throw new Error("Standalone web search returned invalid result metadata.");
	return {
		content: [{ type: "text", text: result.output }],
		structuredContent: { output: result.output, results: result.results ?? [] },
		details: {
			mode: "standalone",
			results: (result.results ?? []) as StandaloneWebSearchResult[],
		} satisfies StandaloneWebSearchDetails,
	};
}

export function createWebSearchToolDefinition(options: {
	hasProviderRuntime?: () => boolean;
	getCurrentTurnId?: (sessionId: string | undefined) => string | undefined;
	getRequestIdentity?: (
		sessionId: string | undefined,
	) => CodexRequestIdentity | undefined;
} = {}) {
	return {
		name: "web_search",
		label: "Web Search",
		description: "Search the web using the implementation selected by the current model profile. Hosted profiles are rewritten into the OpenAI Responses web_search tool; standalone profiles call the Codex alpha/search endpoint.",
		promptSnippet: "Search the web when current information or citations are needed.",
		promptGuidelines: ["Use web_search when current web information or cited sources are needed."],
		parameters: webSearchToolSchema,
		outputSchema: webSearchOutputSchema,
		renderCall(input: WebSearchInput, theme: any, context: { cwd?: string }) {
			return renderStandaloneWebSearchCall(input ?? {}, theme, context?.cwd);
		},
		renderResult(
			result: { content?: Array<{ type?: string; text?: string }>; details?: StandaloneWebSearchDetails },
			renderOptions: { expanded?: boolean; isPartial?: boolean },
			theme: any,
			context: { cwd?: string; isError?: boolean },
		) {
			return renderStandaloneWebSearchResult(result, renderOptions, theme, context);
		},
		async execute(
			_toolCallId: string,
			input: WebSearchInput,
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: WebSearchToolContext,
		) {
			const settings = loadModelSettings(ctx.model ? { ...ctx.model, baseUrl: undefined } : undefined, ctx.cwd);
			if (settings.webSearchImplementation === "standalone") {
				const sessionId = ctx.sessionManager?.getSessionId();
				const identity = options.getRequestIdentity?.(sessionId);
				return standaloneWebSearch(input, ctx, signal, {
					turnId: identity?.turnId
						?? options.getCurrentTurnId?.(sessionId),
					identity,
				});
			}
			if (options.hasProviderRuntime?.() === false) {
				throw new Error("Hosted web_search requires pi-codex-core. Use a catalog-supported standalone profile for independent execution.");
			}
			return {
				isError: true,
				content: [{ type: "text", text: "web_search is hosted-provider-first for this model profile and should be rewritten before execution." }],
				details: { phase: "native-provider", nativeTool: "web_search" },
			};
		},
	};
}
