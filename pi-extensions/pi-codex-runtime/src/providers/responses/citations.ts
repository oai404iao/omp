import { type Api, type Context, type Model } from "@earendil-works/pi-ai";
import { cloneJsonRecord, sanitizeWebSearchCallItem } from "./items.js";
import { decodeWebSearchActivityTextSignature, isWebSearchActivityTextSignature, parseTextSignature } from "./signatures.js";
import { type CitationSource, type InternalAssistantContent, type WebSearchCitationSource } from "./types.js";

export const INTERNAL_CITATION_MARKER = /cite([^]+)/;

const INTERNAL_CITATION_REF = /^turn\d+[a-z][a-z0-9_-]*\d+$/i;

function citationRefsFromResult(result: Record<string, unknown>): string[] {
	const refs = new Set<string>();
	for (const key of ["ref_id", "reference_id", "id"]) {
		const value = result[key];
		if (typeof value === "string" && INTERNAL_CITATION_REF.test(value)) refs.add(value);
	}
	if (typeof result.snippet === "string") {
		const marker = INTERNAL_CITATION_MARKER.exec(result.snippet.slice(0, 2048));
		for (const ref of marker?.[1]?.split("") ?? []) {
			const trimmed = ref.trim();
			if (INTERNAL_CITATION_REF.test(trimmed)) refs.add(trimmed);
		}
	}
	return [...refs];
}

export function extractWebSearchCitationSources(item: unknown): WebSearchCitationSource[] {
	const replayItem = sanitizeWebSearchCallItem(item);
	if (!replayItem) return [];
	const actionResults = Array.isArray(replayItem.action.results)
		? replayItem.action.results.map(cloneJsonRecord).filter((result): result is Record<string, unknown> => !!result)
		: [];
	const results = [...(replayItem.results ?? []), ...actionResults];
	const sources: WebSearchCitationSource[] = [];
	const seen = new Set<string>();
	for (const result of results) {
		const url = typeof result.url === "string" && result.url.trim() ? result.url.trim() : undefined;
		if (!url) continue;
		const title = typeof result.title === "string" && result.title.trim() ? result.title.trim() : undefined;
		for (const refId of citationRefsFromResult(result)) {
			const key = `${refId}\n${url}`;
			if (seen.has(key)) continue;
			seen.add(key);
			sources.push({ refId, url, ...(title ? { title } : {}) });
		}
	}
	return sources;
}

export function collectWebSearchCitationSources<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
): WebSearchCitationSource[] {
	const byRef = new Map<string, WebSearchCitationSource>();
	for (const message of context.messages) {
		if (message.role !== "assistant") continue;
		if (message.provider !== model.provider || message.api !== model.api || message.model !== model.id) continue;
		for (const block of message.content as InternalAssistantContent[]) {
			if (block.type !== "text") continue;
			const item = decodeWebSearchActivityTextSignature(block.textSignature);
			if (!item) continue;
			for (const source of extractWebSearchCitationSources(item)) byRef.set(source.refId, source);
		}
	}
	return [...byRef.values()];
}

export function collectHistoricalCitationSources<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
): CitationSource[] {
	let latestSources: CitationSource[] = [];
	for (const message of context.messages) {
		if (message.role !== "assistant") continue;
		if (message.provider !== model.provider || message.api !== model.api || message.model !== model.id) continue;
		const messageSources: CitationSource[] = [];
		const seenUrls = new Set<string>();
		const pushSource = (source: CitationSource): void => {
			if (!source.url || seenUrls.has(source.url)) return;
			seenUrls.add(source.url);
			messageSources.push(source);
		};
		for (const block of message.content as InternalAssistantContent[]) {
			if (block.type !== "text" || isWebSearchActivityTextSignature(block.textSignature)) continue;
			const markdownLinkPattern = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;
			for (const match of block.text.matchAll(markdownLinkPattern)) {
				pushSource({ title: match[1], url: match[2] });
			}
			const replayItem = parseTextSignature(block.textSignature)?.item;
			for (const part of replayItem?.content ?? []) {
				if (part.type !== "output_text") continue;
				for (const annotation of part.annotations) {
					const url = annotation.type === "url_citation" && typeof annotation.url === "string"
						? annotation.url.trim()
						: "";
					const title = typeof annotation.title === "string" && annotation.title.trim()
						? annotation.title.trim()
						: undefined;
					if (url) pushSource({ url, ...(title ? { title } : {}) });
				}
			}
		}
		if (messageSources.length > 0) latestSources = messageSources;
	}
	return latestSources;
}
