import { glyphs } from "../../glyphs.js";
import { type StreamEventShape } from "../../providers/openai-codex/types.js";

export const WEB_SEARCH_ACTIVITY_MESSAGE_TYPE = "codex-web-search-activity";

export interface SurfacedWebSearch {
	callId: string;
	status?: string;
	completed?: boolean;
	actionType?: string;
	query?: string;
	queries: string[];
	url?: string;
	pattern?: string;
	sources: Array<{ title?: string; url: string }>;
	responseItem?: Record<string, unknown>;
}

export function extractWebSearch(
	item: StreamEventShape["item"],
	options?: { completed?: boolean },
): SurfacedWebSearch | undefined {
	if (!item || item.type !== "web_search_call") return undefined;
	const callId = typeof item.id === "string" ? item.id : typeof item.call_id === "string" ? item.call_id : undefined;
	if (!callId) return undefined;

	const action = typeof item.action === "object" && item.action !== null ? (item.action as Record<string, unknown>) : undefined;
	const actionType = typeof action?.type === "string" ? action.type : undefined;
	const query = typeof action?.query === "string" ? action.query : typeof item.query === "string" ? item.query : undefined;
	const queries = [
		...(Array.isArray(action?.queries) ? action.queries : []),
		...(Array.isArray(item.queries) ? item.queries : []),
	].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
	const url = typeof action?.url === "string" && action.url.trim()
		? action.url.trim()
		: typeof item.url === "string" && item.url.trim()
			? item.url.trim()
			: undefined;
	const pattern = typeof action?.pattern === "string" && action.pattern.trim() ? action.pattern.trim() : undefined;

	const asRecordArray = (value: unknown): Record<string, unknown>[] => Array.isArray(value)
		? value
				.map((entry) => typeof entry === "object" && entry !== null ? entry as Record<string, unknown> : undefined)
				.filter((entry): entry is Record<string, unknown> => !!entry)
		: [];
	const sourceCandidates = [
		...asRecordArray(action?.sources),
		...asRecordArray(action?.results),
		...asRecordArray(item.results),
	];
	if (typeof item.url === "string") sourceCandidates.push(item as Record<string, unknown>);

	const seenUrls = new Set<string>();
	const sources: Array<{ title?: string; url: string }> = [];
	for (const source of sourceCandidates) {
		const url = typeof source.url === "string" && source.url.trim() ? source.url.trim() : undefined;
		if (!url || seenUrls.has(url)) continue;
		seenUrls.add(url);
		const title = typeof source.title === "string" && source.title.trim() ? source.title.trim() : undefined;
		sources.push({ ...(title ? { title } : {}), url });
	}

	return {
		callId,
		...(typeof item.status === "string" ? { status: item.status } : {}),
		...(options?.completed !== undefined ? { completed: options.completed } : {}),
		...(actionType ? { actionType } : {}),
		...(query ? { query } : {}),
		queries,
		...(url ? { url } : {}),
		...(pattern ? { pattern } : {}),
		sources,
		...(options?.completed ? { responseItem: item as Record<string, unknown> } : {}),
	};
}

export function extractWebSearchProgress(event: StreamEventShape): SurfacedWebSearch | undefined {
	const status = event.type === "response.web_search_call.in_progress"
		? "in_progress"
		: event.type === "response.web_search_call.searching"
			? "searching"
			: event.type === "response.web_search_call.completed"
				? "completed"
				: undefined;
	if (!status || typeof event.item_id !== "string" || !event.item_id) return undefined;
	return {
		callId: event.item_id,
		status,
		completed: status === "completed",
		queries: [],
		sources: [],
	};
}

export function mergeWebSearchActivity(
	previous: SurfacedWebSearch | undefined,
	next: SurfacedWebSearch,
): SurfacedWebSearch {
	if (!previous) return next;
	const seenUrls = new Set<string>();
	const sources = [...next.sources, ...previous.sources].filter((source) => {
		if (seenUrls.has(source.url)) return false;
		seenUrls.add(source.url);
		return true;
	});
	const completed = Boolean(previous.completed || next.completed);
	return {
		callId: next.callId,
		status: previous.completed && !next.completed ? previous.status : (next.status ?? previous.status),
		completed,
		actionType: next.actionType ?? previous.actionType,
		query: next.query ?? previous.query,
		queries: next.queries.length > 0 ? next.queries : previous.queries,
		url: next.url ?? previous.url,
		pattern: next.pattern ?? previous.pattern,
		sources,
		responseItem: next.responseItem ?? previous.responseItem,
	};
}

export function webSearchActivityDetail(search: SurfacedWebSearch): string {
	if (search.actionType === "open_page") return search.url ?? "";
	if (search.actionType === "find_in_page") {
		if (search.pattern && search.url) return `'${search.pattern}' in ${search.url}`;
		if (search.pattern) return `'${search.pattern}'`;
		return search.url ?? "";
	}
	const query = search.query?.trim();
	if (query) return query;
	const first = search.queries[0]?.trim() ?? "";
	return search.queries.length > 1 && first ? `${first} ...` : first;
}

export function webSearchActivityHosts(search: SurfacedWebSearch): string[] {
	const seen = new Set<string>();
	const hosts: string[] = [];
	for (const source of search.sources) {
		try {
			const host = new URL(source.url).hostname.replace(/^www\./i, "");
			const key = host.toLowerCase();
			if (!host || seen.has(key)) continue;
			seen.add(key);
			hosts.push(host);
		} catch {
			// Sources without a valid URL do not produce a host tag.
		}
	}
	return hosts;
}

export function buildWebSearchStatusText(search: SurfacedWebSearch): string {
	const completed = search.completed ?? search.status === "completed";
	const detail = webSearchActivityDetail(search);
	if (completed) return `Searched the web${detail ? ` for ${detail}` : ""}`;
	return `Searching the web${detail ? ` ${detail}` : ""}`;
}

export function buildWebSearchInlineText(search: SurfacedWebSearch, cwd?: string): string {
	const completed = search.completed ?? search.status === "completed";
	const header = completed ? "Searched the web" : "Searching the web";
	const detail = webSearchActivityDetail(search);
	const separator = detail ? (completed ? " for " : " ") : "";
	return `${glyphs(cwd).bullet}**${header}**${separator}${detail}`;
}

export function buildWebSearchActivityMessage(searches: SurfacedWebSearch[]): string {
	const sections = searches.map((search, index) => {
		const heading = searches.length > 1
			? `${index + 1}. ${buildWebSearchStatusText(search)}`
			: buildWebSearchStatusText(search);
		const lines = [heading, `Call: ${search.callId}${search.status ? ` (${search.status})` : ""}`];
		const queries = search.queries.length > 0 ? search.queries : search.query ? [search.query] : [];
		if (queries.length > 0) {
			lines.push(`Query: ${queries.join(" | ")}`);
		}
		if (search.sources.length > 0) {
			lines.push("Sources:");
			for (const source of search.sources.slice(0, 8)) {
				lines.push(`- ${source.title ? `${source.title}: ` : ""}${source.url}`);
			}
		}
		return lines.join("\n");
	});

	return sections.join("\n\n");
}

export function buildWebSearchSummaryText(searches: SurfacedWebSearch[]): string {
	if (searches.length === 0) return "Web search";
	if (searches.length === 1) return buildWebSearchStatusText(searches[0]!);
	const completed = searches.filter((search) => search.completed ?? search.status === "completed").length;
	if (completed === searches.length) return `Searched the web ${searches.length} times`;
	if (completed === 0) return `Searching the web (${searches.length} calls)`;
	return `Web search activity (${completed}/${searches.length} completed)`;
}
