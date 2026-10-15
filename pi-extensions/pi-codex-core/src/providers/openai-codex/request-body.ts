import { type Api, type Context, type Model, type SimpleStreamOptions, type ThinkingLevel } from "@earendil-works/pi-ai/compat";
import { type CodexRequestProfile } from "@oai404iao/pi-codex-runtime/internal/codex-request-profile";
import { createCodexReservedNamespaceTool } from "@oai404iao/pi-codex-runtime/internal/codex-reserved-tools";
import { resolveCodexRequestIdentity, type CodexRequestIdentity } from "@oai404iao/pi-codex-runtime/internal/codex-wire-identity";
import { type ReasoningSummary } from "@oai404iao/pi-codex-runtime/internal/model-catalog/types";
import type { ToolProtocol } from "@oai404iao/pi-codex-runtime/internal/broker";
import { convertResponsesMessages } from "@oai404iao/pi-codex-runtime/internal/providers/responses/messages";
import { convertResponsesTools } from "@oai404iao/pi-codex-runtime/internal/providers/responses/tools";
import { responseGrammarProperties, supportsGrammar } from "@oai404iao/pi-codex-runtime/internal/providers/responses/grammar";
import { CODEX_TOOL_CALL_PROVIDERS, WEB_SEARCH_RESULTS_INCLUDE, WEB_SEARCH_SOURCES_INCLUDE } from "./constants.js";
import { stripResponsesLiteImageDetails } from "./lite.js";
import { clampCodexThinkingLevel, clampReasoningEffort } from "./reasoning.js";
import { type ResponsesBody, type NativeToolOwnership } from "@oai404iao/pi-codex-runtime/internal/providers/openai-codex/types";
import { loadModelSettings, type ResolvedCodexModelSettings } from "@oai404iao/pi-codex-runtime/internal/model-catalog/runtime";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { requestPrefix } from "./request-prefix.js";

// Sampling overrides must not change the reviewed request envelope or enable
// provider capabilities independently of the model profile and authentication.
const PROTECTED_SAMPLING_KEYS = new Set([
	"model", "input", "instructions", "prompt", "tools", "tool_choice", "parallel_tool_calls",
	"reasoning", "reasoning_effort", "reasoning_summary", "text", "response_format",
	"store", "stream", "stream_options", "include", "service_tier",
	"prompt_cache_key", "prompt_cache_retention", "prompt_cache_options",
	"metadata", "client_metadata", "previous_response_id", "generate",
	"background", "conversation", "truncation", "max_tool_calls", "context_management",
	"max_tokens", "max_completion_tokens",
	"additional_tools", "compaction_trigger", "safety_identifier", "user",
	"apiKey", "api_key", "auth", "authorization", "headers", "baseUrl", "base_url",
	"url", "endpoint", "provider", "transport", "sessionId", "session_id",
	"__proto__", "constructor", "prototype",
]);

export function requestBodyToolOptions(settings: ResolvedCodexModelSettings) {
	return {
		modelSettings: settings,
		codexRequestExtensions: settings.codexRequestExtensions,
		imageGeneration: settings.imageGenerationImplementation ?? false,
		removeWebSearch: settings.endpointDisabledWebSearch,
	} as const;
}

function hasNativeWebSearchTool(body: ResponsesBody): boolean {
	return Array.isArray(body.tools) && body.tools.some((tool) => Boolean(tool) && typeof tool === "object" && (tool as { type?: unknown }).type === "web_search");
}

export function ensureWebSearchDetailsIncluded(body: ResponsesBody): void {
	if (!hasNativeWebSearchTool(body)) return;
	const include = Array.isArray(body.include) ? body.include : [];
	const missing = [WEB_SEARCH_SOURCES_INCLUDE, WEB_SEARCH_RESULTS_INCLUDE].filter((value) => !include.includes(value));
	if (missing.length > 0) body.include = [...include, ...missing];
}

export function requestGrammarProperties(
	body: { tools?: unknown; input?: unknown }, tools: Context["tools"],
	protocols?: ReadonlyMap<string, ToolProtocol>,
): ReadonlyMap<string, string> {
	const properties = new Map(responseGrammarProperties(body, tools, true));
	for (const [name, protocol] of protocols ?? []) {
		if (properties.has(name)) properties.set(name, protocol.inputProperty);
	}
	return properties;
}

export function buildRequestBody<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	profile: CodexRequestProfile,
	options?: SimpleStreamOptions & {
		ownsNativeTool?: NativeToolOwnership;
		imageGeneration?: false | "standalone";
		modelSettings?: ResolvedCodexModelSettings;
		requestIdentity?: CodexRequestIdentity;
		codexRequestExtensions?: boolean;
		removeWebSearch?: boolean;
		toolProtocols?: ReadonlyMap<string, ToolProtocol>;
	},
): ResponsesBody {
	const requestIdentity = options?.codexRequestExtensions === false ? undefined : options?.requestIdentity ?? resolveCodexRequestIdentity(
		options?.sessionId,
		options?.metadata as Record<string, unknown> | undefined,
		// Only the session-scoped prompt cache key is needed here. Do not
		// synthesize a logical turn while constructing startup/prewarm bodies.
		"prewarm",
	);
	const settings = options?.modelSettings ?? loadModelSettings(model);
	const capabilities = settings.modelProfile?.effective.responses;
	const tools = context.tools && context.tools.length > 0
		? convertResponsesTools(context.tools, { strict: null, supportsOpenAIGrammarTools: supportsGrammar(model) }).map((tool) =>
			profile.patchTransport === "custom" && tool.type === "function" && options?.toolProtocols?.has(tool.name)
				? { ...options.toolProtocols.get(tool.name)!.customTool } : tool)
		: [];
	const messages = convertResponsesMessages(model, context, new Set([...CODEX_TOOL_CALL_PROVIDERS, model.provider]), {
		includeSystemPrompt: false, grammarToolInputProperties: requestGrammarProperties({ tools }, context.tools, options?.toolProtocols),
	});
	const lite = profile.responsesMode === "lite";
	const liteTools = (): unknown[] => {
		const namespaces = new Map<string, {
			type: "namespace";
			name: string;
			description: string;
			tools: unknown[];
		}>();
		for (const tool of tools as Array<Record<string, unknown>>) {
			if (typeof tool.name !== "string") continue;
			if (tool.name === "web_search" && options?.ownsNativeTool?.("web_search") === true && options.removeWebSearch) continue;
			if (tool.name === "image_generation"
				&& options?.ownsNativeTool?.("image_generation") === true
				&& options.imageGeneration === false) {
				continue;
			}
			if ((tool.name === "web_search" || tool.name === "image_generation")
				&& options?.ownsNativeTool?.(tool.name) !== false) {
				const reserved = createCodexReservedNamespaceTool(tool.name);
				namespaces.set(reserved.name, reserved);
				continue;
			}
			let namespace = namespaces.get("functions");
			if (!namespace) {
				namespace = {
					type: "namespace",
					name: "functions",
					description: "",
					tools: [],
				};
				namespaces.set("functions", namespace);
			}
			const nestedTool: Record<string, unknown> = { ...tool };
			if (nestedTool.type === "function" && typeof nestedTool.strict !== "boolean") {
				nestedTool.strict = false;
			}
			namespace.tools.push(nestedTool);
		}
		return [...namespaces.values()].filter((namespace) => namespace.tools.length > 0);
	};

	const body: ResponsesBody = {
		model: model.id,
		store: false,
		stream: true,
		input: [],
		include: ["reasoning.encrypted_content"],
		prompt_cache_key: options?.cacheRetention === "none" ? undefined : requestIdentity?.sessionId ?? options?.sessionId,
		tool_choice: "auto",
		parallel_tool_calls: profile.responsesMode !== "lite" && profile.supportsParallelTools,
	};
	if (capabilities?.supportsVerbosity) {
		const verbosity = (options as { textVerbosity?: string } | undefined)?.textVerbosity ?? capabilities.defaultVerbosity;
		if (verbosity) body.text = { verbosity };
	}
	if (lite) {
		stripResponsesLiteImageDetails(messages);
		body.input = [...requestPrefix(requestIdentity?.threadId, context.systemPrompt, liteTools()), ...messages];
		body.reasoning = { context: "all_turns" };
	} else {
		body.input = [...requestPrefix(requestIdentity?.threadId, context.systemPrompt), ...messages];
		body.tools = tools;
	}

	// Match Pi 0.99.1's private isChatGPTSignIn predicate, not an auth selector.
	// Proxies and header-only auth must not be classified by token shape alone.
	const chatGPTSignIn = model.provider === "openai"
		&& model.baseUrl === "https://api.openai.com/v1"
		&& options?.apiKey !== undefined
		&& !options.apiKey.startsWith("sk-");
	if (options?.temperature !== undefined && !chatGPTSignIn) {
		body.temperature = options.temperature;
	}
	const supportsMaxOutputTokens = model.api === "openai-responses" && !lite && !chatGPTSignIn
		&& (model as Model<"openai-responses">).compat?.supportsMaxOutputTokens !== false;
	if (supportsMaxOutputTokens && options?.maxTokens) {
		body.max_output_tokens = Math.max(16, options.maxTokens);
	}

	const serviceTier = (options as { serviceTier?: string } | undefined)?.serviceTier;
	if (serviceTier === "flex" || (serviceTier !== undefined && serviceTier === settings.fastServiceTier)) {
		body.service_tier = serviceTier;
	}

	const clampedReasoning = options?.reasoning
		? profile.responsesMode === "standard" && model.api === "openai-responses"
			? clampThinkingLevel(model, options.reasoning)
			: clampCodexThinkingLevel(model as Model<Api>, options.reasoning)
		: undefined;
	if (model.api === "openai-responses") {
		const samplingLevel = clampThinkingLevel(model, clampedReasoning ?? "off");
		const sampling = {
			...model.samplingParams,
			...model.samplingParamsByThinkingLevel?.[samplingLevel],
			...options?.samplingParams,
		};
		for (const [key, value] of Object.entries(sampling)) {
			if (PROTECTED_SAMPLING_KEYS.has(key) || /^x[-_]codex[-_]/i.test(key)) continue;
			// Lite has no reviewed contract for additional free-form sampling fields.
			if (lite && key !== "temperature") continue;
			if (key === "temperature" && chatGPTSignIn) continue;
			if (key === "max_output_tokens") {
				if (supportsMaxOutputTokens && typeof value === "number" && Number.isFinite(value) && value > 0) {
					body.max_output_tokens = Math.max(16, value);
				}
				continue;
			}
			body[key] = value;
		}
	}
	const reasoningEffort = clampedReasoning === "off"
		? model.thinkingLevelMap?.off ?? undefined : clampedReasoning;
	if (reasoningEffort !== undefined && model.reasoning) {
		const effort = clampedReasoning === undefined || clampedReasoning === "off"
			? reasoningEffort : model.thinkingLevelMap?.[reasoningEffort as ThinkingLevel] ?? reasoningEffort;
		if (effort === null) return body;
		const reasoning = body.reasoning ?? {};
		reasoning.effort = clampReasoningEffort(model.id, effort);
		const summary = (options as { reasoningSummary?: ReasoningSummary | null } | undefined)?.reasoningSummary
			?? profile.reasoningSummary;
		if (capabilities?.supportsReasoningSummary && summary && summary !== "none") reasoning.summary = summary;
		body.reasoning = reasoning;
	} else if (model.reasoning && clampedReasoning !== "off") {
		const reasoning = body.reasoning ?? {};
		if (capabilities?.defaultReasoningEffort) reasoning.effort = capabilities.defaultReasoningEffort;
		if (capabilities?.supportsReasoningSummary && profile.reasoningSummary !== "none") reasoning.summary = profile.reasoningSummary;
		body.reasoning = reasoning;
	}

	return body;
}
