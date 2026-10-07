import { createCodexReservedNamespaceTool } from "@oai404iao/pi-codex-runtime/internal/codex-reserved-tools";
import type { NativeToolOwnership } from "@oai404iao/pi-codex-runtime/internal/providers/openai-codex/types";
import type { WebSearchProfile } from "@oai404iao/pi-codex-runtime/internal/model-catalog/types";

export interface NativeToolRewriteResult<T = unknown> {
	payload: T;
	rewritten: string[];
	removed: string[];
}

export interface NativeToolRewriteOptions {
	codexRequestExtensions?: boolean;
	removeWebSearch?: boolean;
	ownsNativeTool?: NativeToolOwnership;
	imageGeneration?: false | "standalone";
	webSearch?: boolean | Partial<WebSearchProfile>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toolName(tool: Record<string, unknown>): string | undefined {
	if (typeof tool.name === "string") return tool.name;
	const nested = isRecord(tool.function) ? tool.function : undefined;
	return typeof nested?.name === "string" ? nested.name : undefined;
}

export function rewriteNativeOpenAiTools<T>(payload: T, options: NativeToolRewriteOptions = {}): NativeToolRewriteResult<T> {
	if (!isRecord(payload) || !Array.isArray(payload.tools)) return { payload, rewritten: [], removed: [] };
	const rewritten: string[] = [];
	const removed: string[] = [];
	const tools = payload.tools.flatMap((candidate) => {
		if (!isRecord(candidate)) return [candidate];
		const name = toolName(candidate);
		if ((name === "web_search" || name === "image_generation")
			&& options.ownsNativeTool?.(name) === false) return [candidate];
		if (name === "image_generation"
			&& options.ownsNativeTool?.(name) === true
			&& options.imageGeneration === false) {
			removed.push(name);
			return [];
		}
		if (name === "web_search" && options.ownsNativeTool?.(name) === true && options.removeWebSearch) {
			removed.push(name);
			return [];
		}
		if (name === "image_generation" && options.imageGeneration !== false) {
			rewritten.push(name);
			if (options.codexRequestExtensions === false) return [candidate];
			return [createCodexReservedNamespaceTool("image_generation")];
		}
		if (name === "web_search" && options.webSearch) {
			rewritten.push(name);
			if (typeof options.webSearch === "object" && options.webSearch.implementation === "standalone") {
				if (options.codexRequestExtensions === false) return [candidate];
				return [createCodexReservedNamespaceTool("web_search")];
			}
			const contentTypes = typeof options.webSearch === "object"
				? options.webSearch.contentTypes
				: undefined;
			const config = typeof options.webSearch === "object" ? options.webSearch : {};
			return [{
				type: "web_search",
				external_web_access: config.mode !== "cached",
				...(config.mode === "indexed" ? { indexed_web_access: true } : {}),
				...(config.searchContextSize ? { search_context_size: config.searchContextSize } : {}),
				...(config.userLocation ? { user_location: config.userLocation } : {}),
				...(config.filters ? { filters: {
					...(config.filters.allowedDomains ? { allowed_domains: config.filters.allowedDomains } : {}),
				} } : {}),
				...(contentTypes && contentTypes.length > 0
					? { search_content_types: [...contentTypes] }
					: {}),
			}];
		}
		return [candidate];
	});
	return { payload: { ...payload, tools } as T, rewritten, removed };
}
