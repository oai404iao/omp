import { type Api, type Context, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { type CodexRequestProfile } from "@oai404iao/pi-codex-runtime/internal/codex-request-profile";
import { createCodexReservedNamespaceTool } from "@oai404iao/pi-codex-runtime/internal/codex-reserved-tools";
import { resolveCodexRequestIdentity } from "@oai404iao/pi-codex-runtime/internal/codex-wire-identity";
import { type ReasoningSummary } from "@oai404iao/pi-codex-runtime/internal/model-catalog/types";
import { createCodexApplyPatchCustomTool } from "../codex-apply-patch-tool.js";
import { convertResponsesMessages } from "@oai404iao/pi-codex-runtime/internal/providers/responses/messages";
import { convertResponsesTools } from "@oai404iao/pi-codex-runtime/internal/providers/responses/tools";
import { responseGrammarProperties, supportsGrammar } from "@oai404iao/pi-codex-runtime/internal/providers/responses/grammar";
import { CODEX_TOOL_CALL_PROVIDERS, WEB_SEARCH_RESULTS_INCLUDE, WEB_SEARCH_SOURCES_INCLUDE } from "./constants.js";
import { stripResponsesLiteImageDetails } from "./lite.js";
import { clampCodexThinkingLevel, clampReasoningEffort } from "./reasoning.js";
import { type ResponsesBody, type NativeToolOwnership } from "@oai404iao/pi-codex-runtime/internal/providers/openai-codex/types";

function hasNativeWebSearchTool(body: ResponsesBody): boolean {
	return Array.isArray(body.tools) && body.tools.some((tool) => Boolean(tool) && typeof tool === "object" && (tool as { type?: unknown }).type === "web_search");
}

export function ensureWebSearchDetailsIncluded(body: ResponsesBody): void {
	if (!hasNativeWebSearchTool(body)) return;
	const include = Array.isArray(body.include) ? body.include : [];
	const missing = [WEB_SEARCH_SOURCES_INCLUDE, WEB_SEARCH_RESULTS_INCLUDE].filter((value) => !include.includes(value));
	if (missing.length > 0) body.include = [...include, ...missing];
}

export function buildRequestBody<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	profile: CodexRequestProfile,
	options?: SimpleStreamOptions & {
		ownsNativeTool?: NativeToolOwnership;
		imageGeneration?: false | "hosted" | "standalone";
	},
): ResponsesBody {
	const requestIdentity = resolveCodexRequestIdentity(
		options?.sessionId,
		options?.metadata as Record<string, unknown> | undefined,
		// Only the session-scoped prompt cache key is needed here. Do not
		// synthesize a logical turn while constructing startup/prewarm bodies.
		"prewarm",
	);
	const tools = context.tools && context.tools.length > 0
		? convertResponsesTools(context.tools, { strict: null, supportsOpenAIGrammarTools: supportsGrammar(model) }).map((tool) =>
			profile.patchTransport === "custom" && tool.type === "function" && tool.name === "apply_patch" ? createCodexApplyPatchCustomTool() : tool)
		: [];
	const messages = convertResponsesMessages(model, context, new Set([...CODEX_TOOL_CALL_PROVIDERS, model.provider]), {
		includeSystemPrompt: false, grammarToolInputProperties: responseGrammarProperties({ tools }, context.tools, true),
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
		text: { verbosity: ((options as { textVerbosity?: string } | undefined)?.textVerbosity ?? "low") as string },
		include: ["reasoning.encrypted_content"],
		prompt_cache_key: requestIdentity?.sessionId ?? options?.sessionId,
		tool_choice: "auto",
		parallel_tool_calls: profile.supportsParallelTools,
	};
	if (lite) {
		stripResponsesLiteImageDetails(messages);
		body.input = [
			{ type: "additional_tools", role: "developer", tools: liteTools() },
			...(context.systemPrompt
				? [{ type: "message", role: "developer", content: [{ type: "input_text", text: context.systemPrompt }] }]
				: []),
			...messages,
		];
		body.reasoning = { context: "all_turns" };
	} else {
		if (profile.systemPromptPlacement === "instructions") {
			body.instructions = context.systemPrompt;
			body.input = messages;
		} else {
			body.input = [
				...(context.systemPrompt
					? [{ type: "message", role: "developer", content: [{ type: "input_text", text: context.systemPrompt }] }]
					: []),
				...messages,
			];
		}
		if (tools.length > 0) body.tools = tools;
	}

	// The Codex ChatGPT-backed endpoint rejects output-token cap fields with
	// `Unsupported parameter: max_output_tokens`. Pi's branch summarizer passes
	// `maxTokens`, so forwarding it breaks `/tree` summaries and extensions that
	// use `ctx.navigateTree(..., { summarize: true })`.

	if ((options as { temperature?: number } | undefined)?.temperature !== undefined) {
		body.temperature = (options as { temperature?: number }).temperature;
	}

	const serviceTier = (options as { serviceTier?: string } | undefined)?.serviceTier;
	if (serviceTier !== undefined) {
		body.service_tier = serviceTier;
	}

	const clampedReasoning = options?.reasoning
		? clampCodexThinkingLevel(model as Model<Api>, options.reasoning)
		: undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;
	if (reasoningEffort !== undefined) {
		const effort = model.thinkingLevelMap?.[reasoningEffort] ?? reasoningEffort;
		if (effort === null) return body;
		const reasoning = body.reasoning ?? {};
		reasoning.effort = clampReasoningEffort(model.id, effort);
		const summary = (options as { reasoningSummary?: ReasoningSummary | null } | undefined)?.reasoningSummary
			?? profile.reasoningSummary;
		if (summary && summary !== "none") reasoning.summary = summary;
		body.reasoning = reasoning;
	} else if (lite && clampedReasoning !== "off") {
		// Match the Codex CLI default reasoning level for Lite models: the CLI
		// always sends `reasoning.effort` (default "low") for gpt-5.6-* models.
		const reasoning = body.reasoning ?? {};
		if (reasoning.effort === undefined) {
			reasoning.effort = model.thinkingLevelMap?.low ?? "low";
		}
		body.reasoning = reasoning;
	}

	return body;
}
