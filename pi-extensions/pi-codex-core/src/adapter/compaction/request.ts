import { type ProviderHeaders } from "@earendil-works/pi-ai";
import { type Api, type Context, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { hasCodexRequestAuth, resolveCodexRequestAccountId } from "@oai404iao/pi-codex-runtime/internal/codex-http";
import { resolveCodexRequestProfile } from "@oai404iao/pi-codex-runtime/internal/codex-request-profile";
import { resolveCodexRequestIdentity } from "@oai404iao/pi-codex-runtime/internal/codex-wire-identity";
import { applyFastModeServiceTier } from "../../fast-mode.js";
import { loadModelSettings, type ResolvedCodexModelSettings } from "@oai404iao/pi-codex-runtime/internal/model-catalog/runtime";
import { setProviderGeneratedHeader } from "@oai404iao/pi-codex-runtime/internal/provider-headers";
import { rewriteNativeOpenAiTools } from "../../provider-native-tools.js";
import { CODEX_COMPACTION_TRIGGER_TYPE, X_OPENAI_INTERNAL_CODEX_RESPONSES_LITE } from "../../providers/openai-codex/constants.js";
import { applyConfiguredResponsesFeatureHeaders, buildJsonHeaders, buildSSEHeaders, buildWebSocketHeaders } from "../../providers/openai-codex/headers.js";
import { buildRequestBody, ensureWebSearchDetailsIncluded } from "../../providers/openai-codex/request-body.js";
import { createCodexRequestId } from "../../providers/openai-codex/request-metadata.js";
import { compactUrl } from "../../providers/openai-codex/urls.js";
import { buildCodexCompactionCheckpoint, compactionItems, sanitizeNativeCompactionOutput } from "./checkpoint.js";
import { postJsonWithRetries } from "./http.js";
import { requestCodexCompactionTriggerWithTransport } from "./transport.js";
import type { NativeToolOwnership } from "@oai404iao/pi-codex-runtime/internal/providers/openai-codex/types";

export async function requestOpenAINativeCompaction(
	model: Model<Api>,
	context: Context,
	options: {
		ownsNativeTool?: NativeToolOwnership;
		mode: "responses" | "responses-compact";
		apiKey: string;
		headers?: ProviderHeaders;
		signal?: AbortSignal;
		reasoning?: SimpleStreamOptions["reasoning"];
		sessionId?: string;
		turnId?: string;
		maxRetries?: number;
		maxRetryDelayMs?: number;
		settings: ResolvedCodexModelSettings;
	},
): Promise<unknown[]> {
	const settings = options.settings.modelProfile
		? options.settings
		: loadModelSettings(model, undefined, options.settings);
	const auth = { apiKey: options.apiKey || undefined, headers: options.headers };
	if (!hasCodexRequestAuth({ modelHeaders: model.headers, auth })) {
		throw new Error(`No request authentication for provider: ${model.provider}`);
	}
	if (settings.compactionMode === "pi") {
		throw new Error("native compaction is disabled by the current model profile");
	}
	const profile = resolveCodexRequestProfile(settings.requestProfile);
	const accountId = resolveCodexRequestAccountId({
		modelHeaders: model.headers,
		auth,
		apiKeyMode: settings.apiKeyMode,
	});
	const requestIdentity = resolveCodexRequestIdentity(
		options.sessionId,
		options.turnId ? { turn_id: options.turnId } : undefined,
		"compaction",
	);
	let body = applyFastModeServiceTier(buildRequestBody(model, context, profile, {
		ownsNativeTool: options.ownsNativeTool,
		apiKey: options.apiKey,
		headers: options.headers,
		signal: options.signal,
		reasoning: options.reasoning,
		sessionId: options.sessionId,
	}), settings, model);
	if (settings.nativeProviderTools) {
		const webSearch = settings.modelProfile?.effective.tools.webSearch;
		body = rewriteNativeOpenAiTools(body, {
			ownsNativeTool: options.ownsNativeTool,
			imageModel: settings.imageModel,
			imageGeneration: settings.imageGenerationImplementation ?? false,
			webSearch: settings.webSearchEnabled
				&& webSearch
				? {
						implementation: webSearch.implementation,
						contentTypes: webSearch.contentTypes,
					}
				: false,
		}).payload;
	}
	ensureWebSearchDetailsIncluded(body);

	if (options.mode === "responses") {
		const retainedInput = [...body.input];
		body.input = [...retainedInput, { type: CODEX_COMPACTION_TRIGGER_TYPE }];
		const sseHeaders = applyConfiguredResponsesFeatureHeaders(buildSSEHeaders(
			model.headers,
			options.headers,
			accountId,
			options.apiKey,
			options.sessionId,
			profile,
			requestIdentity?.threadId,
			requestIdentity,
		), settings, model);
		const requestId = requestIdentity?.threadId
			?? options.sessionId
			?? createCodexRequestId();
		const websocketHeaders = applyConfiguredResponsesFeatureHeaders(buildWebSocketHeaders(
			model.headers,
			options.headers,
			accountId,
			options.apiKey,
			requestId,
			requestId,
			requestIdentity,
		), settings, model);
		const item = await requestCodexCompactionTriggerWithTransport(
			model,
			{ sse: sseHeaders, websocket: websocketHeaders },
			body,
			{
				sessionId: options.sessionId,
				turnId: options.turnId,
				requestIdentity,
				signal: options.signal,
				settings,
				maxRetries: options.maxRetries,
				maxRetryDelayMs: options.maxRetryDelayMs,
			},
		);
		return buildCodexCompactionCheckpoint(retainedInput, item);
	}

	const headers = buildJsonHeaders(
		model.headers,
		options.headers,
		accountId,
		options.apiKey,
		options.sessionId,
		requestIdentity,
	);
	if (profile.responsesMode === "lite") {
		setProviderGeneratedHeader(headers, X_OPENAI_INTERNAL_CODEX_RESPONSES_LITE, "true");
	}
	const compactBody: Record<string, unknown> = {
		model: body.model,
		input: body.input,
		parallel_tool_calls: body.parallel_tool_calls,
	};
	for (const key of ["instructions", "tools", "reasoning", "service_tier", "prompt_cache_key", "text"] as const) {
		if (body[key] !== undefined) compactBody[key] = body[key];
	}
	const response = await postJsonWithRetries(
		compactUrl(model.baseUrl, settings.apiKeyMode),
		headers,
		compactBody,
		options.signal,
	);
	const output = response.output;
	if (!Array.isArray(output) || output.length === 0) {
		throw new Error("OpenAI /responses/compact returned no replacement output");
	}
	const sanitizedOutput = sanitizeNativeCompactionOutput(output);
	if (compactionItems(sanitizedOutput).length === 0) {
		throw new Error("OpenAI /responses/compact output did not contain a compaction item");
	}
	return sanitizedOutput;
}
