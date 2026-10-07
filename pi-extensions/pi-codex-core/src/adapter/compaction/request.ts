import { type ProviderHeaders } from "@earendil-works/pi-ai";
import { type Api, type Context, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { hasCodexRequestAuth, resolveCodexRequestAccountId, withResolvedAuthBaseUrl } from "@oai404iao/pi-codex-runtime/internal/codex-http";
import { resolveCodexRequestProfile } from "@oai404iao/pi-codex-runtime/internal/codex-request-profile";
import { resolveCodexRequestIdentity, type CodexRequestIdentity } from "@oai404iao/pi-codex-runtime/internal/codex-wire-identity";
import { applyFastModeServiceTier } from "../../fast-mode.js";
import { applyEndpointPolicy, loadModelSettings, type ResolvedCodexModelSettings } from "@oai404iao/pi-codex-runtime/internal/model-catalog/runtime";
import { rewriteNativeOpenAiTools } from "../../provider-native-tools.js";
import { CODEX_COMPACTION_TRIGGER_TYPE } from "../../providers/openai-codex/constants.js";
import { applyConfiguredResponsesFeatureHeaders, buildSSEHeaders, buildWebSocketHeaders } from "../../providers/openai-codex/headers.js";
import { buildRequestBody, ensureWebSearchDetailsIncluded, requestBodyToolOptions } from "../../providers/openai-codex/request-body.js";
import { createCodexRequestId } from "../../providers/openai-codex/request-metadata.js";
import { buildCodexCompactionCheckpoint } from "./checkpoint.js";
import { requestCodexCompactionTriggerWithTransport } from "./transport.js";
import type { NativeToolOwnership } from "@oai404iao/pi-codex-runtime/internal/providers/openai-codex/types";
import type { CodexMinimalToolsSettings } from "@oai404iao/pi-codex-runtime/internal/settings";
import { rememberResolvedEndpoint, reportEndpointFailure } from "@oai404iao/pi-codex-runtime/internal/endpoint-state";

async function requestNativeCompaction(
	model: Model<Api>,
	context: Context,
	options: {
		ownsNativeTool?: NativeToolOwnership;
		mode: "responses";
		apiKey: string;
		headers?: ProviderHeaders;
		baseUrl?: string;
		signal?: AbortSignal;
		reasoning?: SimpleStreamOptions["reasoning"];
		sessionId?: string;
		turnId?: string;
		compaction?: CodexRequestIdentity["compaction"];
		maxRetries?: number;
		maxRetryDelayMs?: number;
		settings: ResolvedCodexModelSettings | CodexMinimalToolsSettings;
	},
): Promise<unknown[]> {
	if (options.mode !== "responses") throw new Error("Only Responses compaction_trigger execution is supported.");
	rememberResolvedEndpoint(model, withResolvedAuthBaseUrl(model, options), options.sessionId);
	model = withResolvedAuthBaseUrl(model, options);
	const settings = "responsesEndpoint" in options.settings && options.settings.modelProfile
		? applyEndpointPolicy(options.settings, model, options.sessionId)
		: loadModelSettings(model, undefined, options.settings, options.sessionId);
	const auth = { apiKey: options.apiKey || undefined, headers: options.headers };
	if (!hasCodexRequestAuth({ modelHeaders: model.headers, auth })) {
		throw new Error(`No request authentication for provider: ${model.provider}`);
	}
	if (settings.compactionMode === "pi" || settings.compactionMode !== options.mode) {
		throw new Error("native compaction is disabled by the current model profile");
	}
	const profile = resolveCodexRequestProfile(settings.requestProfile);
	const accountId = resolveCodexRequestAccountId({
		modelHeaders: model.headers,
		auth,
		endpoint: settings.responsesEndpoint,
	});
	let requestIdentity = resolveCodexRequestIdentity(
		options.sessionId,
		options.turnId ? { turn_id: options.turnId } : undefined,
		"compaction",
	);
	let body = applyFastModeServiceTier(buildRequestBody(model, context, profile, {
		ownsNativeTool: options.ownsNativeTool,
		...requestBodyToolOptions(settings),
		apiKey: options.apiKey,
		headers: options.headers,
		signal: options.signal,
		reasoning: options.reasoning,
		sessionId: options.sessionId,
		requestIdentity,
	}), settings, model);
	if (requestIdentity) requestIdentity = {
		...requestIdentity, model: model.id, reasoningEffort: body.reasoning?.effort, compaction: options.compaction,
	};
	const webSearch = settings.modelProfile?.effective.tools.webSearch;
	body = rewriteNativeOpenAiTools(body, {
		...requestBodyToolOptions(settings),
		ownsNativeTool: options.ownsNativeTool,
		webSearch: settings.webSearchEnabled && webSearch ? webSearch : false,
	}).payload;
	ensureWebSearchDetailsIncluded(body);

	const retainedInput = [...body.input];
	body.input = [...retainedInput, { type: CODEX_COMPACTION_TRIGGER_TYPE }];
	const sseHeaders = applyConfiguredResponsesFeatureHeaders(buildSSEHeaders(
		model.headers, options.headers, accountId, options.apiKey, options.sessionId,
		profile, requestIdentity?.threadId, requestIdentity, settings.codexRequestExtensions, settings.responsesEndpoint,
	), settings, model);
	const requestId = requestIdentity?.threadId ?? options.sessionId ?? createCodexRequestId();
	const websocketHeaders = applyConfiguredResponsesFeatureHeaders(buildWebSocketHeaders(
		model.headers, options.headers, accountId, options.apiKey, requestId,
		requestId, requestIdentity, settings.codexRequestExtensions, settings.responsesEndpoint,
	), settings, model);
	const item = await requestCodexCompactionTriggerWithTransport(
		model, { sse: sseHeaders, websocket: websocketHeaders }, body,
		{
			sessionId: options.sessionId, turnId: options.turnId, requestIdentity,
			signal: options.signal, settings,
			maxRetries: options.maxRetries, maxRetryDelayMs: options.maxRetryDelayMs,
		},
	);
	return buildCodexCompactionCheckpoint(retainedInput, item);
}

export async function requestOpenAINativeCompaction(...args: Parameters<typeof requestNativeCompaction>): Promise<unknown[]> {
	try {
		return await requestNativeCompaction(...args);
	} catch (error) {
		const [model, , options] = args;
		if (!options.signal?.aborted) reportEndpointFailure(
			withResolvedAuthBaseUrl(model, options), options.sessionId, [`compaction.${options.mode}`], error,
		);
		throw error;
	}
}
