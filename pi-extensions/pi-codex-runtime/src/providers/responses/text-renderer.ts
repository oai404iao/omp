import { INTERNAL_CITATION_MARKER } from "./citations.js";
import { isInsideMarkdownCode, markdownCodeRanges, trailingCitationFragmentStart, trailingIndexedSourceFragmentStart } from "./markdown.js";
import type { CitationSource, MessagePartState, WebSearchCitationSource } from "./types.js";

export function createResponseTextRenderer(
	webSearchCitationSources: ReadonlyMap<string, WebSearchCitationSource>,
	historicalCitationSources: ReadonlyArray<CitationSource>,
) {


	const annotationUrl = (annotation: unknown): string | undefined => {
		const candidate = annotation && typeof annotation === "object" ? annotation as Record<string, unknown> : undefined;
		return candidate?.type === "url_citation" && typeof candidate.url === "string" && candidate.url.trim() ? candidate.url.trim() : undefined;
	};

	const annotationTitle = (annotation: unknown): string | undefined => {
		const candidate = annotation && typeof annotation === "object" ? annotation as Record<string, unknown> : undefined;
		return typeof candidate?.title === "string" && candidate.title.trim() ? candidate.title.trim() : undefined;
	};

	const markdownLinkText = (value: string): string => value.replace(/\\/g, "\\\\").replace(/]/g, "\\]").replace(/\n+/g, " ");

	const markdownLinkUrl = (value: string): string => value.replace(/[)\s]/g, (char) => encodeURIComponent(char));

	const containsMarkdownLink = (value: string): boolean => /\[[^\]\n]+\]\([^) \n]+\)/.test(value);

	const citationSourceLabel = (source: CitationSource): string => {
		try {
			const hostname = new URL(source.url).hostname.replace(/^www\./, "");
			if (hostname) return hostname;
		} catch {
			// Fall back to the result title or URL.
		}
		return source.title ?? source.url;
	};

	const citationSourceMarkdown = (source: CitationSource): string =>
		`[${markdownLinkText(citationSourceLabel(source))}](${markdownLinkUrl(source.url)})`;

	const renderInternalCitationMarkers = (text: string): string => {
		const initialCodeRanges = markdownCodeRanges(text);
		const fragmentStart = trailingCitationFragmentStart(text, initialCodeRanges);
		const visibleText = fragmentStart === undefined ? text : text.slice(0, fragmentStart);
		const codeRanges = fragmentStart === undefined ? initialCodeRanges : markdownCodeRanges(visibleText);
		const markerPattern = new RegExp(INTERNAL_CITATION_MARKER.source, "g");
		let cursor = 0;
		let rendered = "";
		for (const match of visibleText.matchAll(markerPattern)) {
			const start = match.index ?? 0;
			if (isInsideMarkdownCode(start, codeRanges)) continue;
			rendered += visibleText.slice(cursor, start);
			const seenUrls = new Set<string>();
			const links: string[] = [];
			for (const rawRef of match[1]?.split("") ?? []) {
				const source = webSearchCitationSources.get(rawRef.trim());
				if (!source || seenUrls.has(source.url)) continue;
				seenUrls.add(source.url);
				links.push(citationSourceMarkdown(source));
			}
			rendered += links.length > 0 ? `(${links.join(", ")})` : "";
			cursor = start + match[0].length;
		}
		if (cursor === 0) return visibleText;
		return rendered + visibleText.slice(cursor);
	};

	const renderIndexedSourceMarkers = (text: string): string => {
		const initialCodeRanges = markdownCodeRanges(text);
		const fragmentStart = trailingIndexedSourceFragmentStart(text, initialCodeRanges);
		const visibleText = fragmentStart === undefined ? text : text.slice(0, fragmentStart);
		const codeRanges = fragmentStart === undefined ? initialCodeRanges : markdownCodeRanges(visibleText);
		const markerPattern = /【(\d+)†source】/gi;
		let cursor = 0;
		let rendered = "";
		for (const match of visibleText.matchAll(markerPattern)) {
			const start = match.index ?? 0;
			if (isInsideMarkdownCode(start, codeRanges)) continue;
			rendered += visibleText.slice(cursor, start);
			const followingText = visibleText.slice(start + match[0].length);
			const alreadyLinked = /^\s*(?:\(\s*)?\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)/.test(followingText);
			const sourceIndex = Number.parseInt(match[1] ?? "", 10);
			const source = Number.isInteger(sourceIndex) ? historicalCitationSources[sourceIndex] : undefined;
			rendered += alreadyLinked || !source ? "" : `(${citationSourceMarkdown(source)})`;
			cursor = start + match[0].length;
		}
		if (cursor === 0) return visibleText;
		return rendered + visibleText.slice(cursor);
	};

	const sourceMarkdown = (annotations: unknown[], citedUrls: Set<string>): string => {
		const seen = new Set<string>();
		const links: string[] = [];
		for (const annotation of annotations) {
			const url = annotationUrl(annotation);
			if (!url || citedUrls.has(url) || seen.has(url)) continue;
			seen.add(url);
			links.push(`[${markdownLinkText(annotationTitle(annotation) ?? url)}](${markdownLinkUrl(url)})`);
		}
		return links.length > 0 ? `\n\nSources: ${links.join(", ")}` : "";
	};

	const renderOutputTextPart = (part: MessagePartState): string => {
		const annotations = part.annotations ?? [];
		if (part.type !== "output_text" || annotations.length === 0) return part.text;
		const spans = annotations
			.map((annotation) => {
				const candidate = annotation && typeof annotation === "object" ? annotation as Record<string, unknown> : undefined;
				const url = annotationUrl(annotation);
				const start = candidate?.start_index;
				const end = candidate?.end_index;
				return typeof start === "number" && typeof end === "number" && url && Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= part.text.length
					? { start, end, url }
					: undefined;
			})
			.filter((span): span is { start: number; end: number; url: string } => !!span)
			.sort((a, b) => a.start - b.start || a.end - b.end);
		const citedUrls = new Set<string>();
		let cursor = 0;
		let rendered = "";
		for (const span of spans) {
			if (span.start < cursor) continue;
			rendered += part.text.slice(cursor, span.start);
			const label = part.text.slice(span.start, span.end);
			rendered += containsMarkdownLink(label)
				? label
				: `[${markdownLinkText(label)}](${markdownLinkUrl(span.url)})`;
			citedUrls.add(span.url);
			cursor = span.end;
		}
		if (cursor === 0) return part.text + sourceMarkdown(annotations, citedUrls);
		rendered += part.text.slice(cursor);
		return rendered + sourceMarkdown(annotations, citedUrls);
	};

	const renderMessageText = (parts: Map<number, MessagePartState>, citations = false): string =>
		Array.from(parts.entries())
			.sort(([a], [b]) => a - b)
			.map(([, part]) => {
				const text = citations ? renderOutputTextPart(part) : part.text;
				return part.type === "output_text"
					? renderIndexedSourceMarkers(renderInternalCitationMarkers(text))
					: text;
			})
			.join("");

	return { renderMessageText };
}
