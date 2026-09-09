import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hasCodexRequestAuth, resolveCodexRequestAccountId } from "@oai404iao/pi-codex-runtime/internal/codex-http";
import { resolveCodexRequestProfile } from "@oai404iao/pi-codex-runtime/internal/codex-request-profile";
import { resolveCodexRequestIdentity } from "@oai404iao/pi-codex-runtime/internal/codex-wire-identity";
import { applyFastModeServiceTier } from "../fast-mode.js";
import { loadModelSettings } from "@oai404iao/pi-codex-runtime/internal/model-catalog/runtime";
import { rewriteNativeOpenAiTools } from "../provider-native-tools.js";
import { webSocketCacheKey, webSocketFallbackKey } from "../providers/openai-codex/cache-key.js";
import { WEBSOCKET_PREWARM_TIMEOUT_MS } from "../providers/openai-codex/constants.js";
import { applyConfiguredResponsesFeatureHeaders, buildWebSocketHeaders } from "../providers/openai-codex/headers.js";
import { withResponsesLiteWebSocketMetadata } from "../providers/openai-codex/lite.js";
import { prewarmWebSocket } from "../providers/openai-codex/prewarm.js";
import { buildRequestBody, ensureWebSearchDetailsIncluded } from "../providers/openai-codex/request-body.js";
import { isWebSocketUpgradeRejectedError } from "../providers/openai-codex/retry.js";
import { resolveResponsesWebSocketUrl } from "../providers/openai-codex/urls.js";
import { websocketHttpFallbackSessions, websocketSessionCache } from "../providers/openai-codex/websocket-session.js";
import { startupPrewarmSnapshot, type StartupPrewarmSnapshot } from "./prewarm-snapshot.js";
import type { NativeToolOwnership } from "@oai404iao/pi-codex-runtime/internal/providers/openai-codex/types";

interface StartupPrewarmState {
	status: "pending" | "ready" | "failed";
	promise: Promise<void>;
	abortController: AbortController;
}

interface SessionStartupPrewarmTask {
	generation: number;
	modelIdentity: string;
	promise: Promise<void>;
	abortController: AbortController;
}

function settleSpeculativeTask(task: Promise<void>, signal: AbortSignal): Promise<void> {
	return new Promise(resolve => {
		const finish = () => {
			signal.removeEventListener("abort", finish);
			resolve();
		};
		signal.addEventListener("abort", finish, { once: true });
		// The auth API may not cooperate with cancellation. Release callers now
		// but keep both handlers attached to consume a late resolution/rejection.
		void task.then(finish, finish);
		if (signal.aborted) finish();
	});
}

export function createStartupPrewarmLifecycle(pi: ExtensionAPI, ownsNativeTool?: NativeToolOwnership) {
	const startupPrewarms = new Map<string, StartupPrewarmState>();
	const sessionStartupPrewarmTasks = new Map<string, SessionStartupPrewarmTask>();
	let sessionGeneration = 0;

	const reset = () => {
		sessionGeneration++;
		for (const state of startupPrewarms.values()) state.abortController.abort();
		for (const task of sessionStartupPrewarmTasks.values()) task.abortController.abort();
		startupPrewarms.clear();
		sessionStartupPrewarmTasks.clear();
	};

	const modelIdentity = (model: Model<Api>): string =>
		`${model.provider}\n${model.api}\n${model.id}\n${model.baseUrl}`;

	const scheduleStartupPrewarm = (
		ctx: ExtensionContext,
		generation: number,
		startupSignal: AbortSignal,
		snapshot: StartupPrewarmSnapshot,
	): Promise<void> => (async () => {
		if (startupSignal.aborted) return;
		const model = ctx.model as Model<Api> | undefined;
		const sessionId = ctx?.sessionManager?.getSessionId?.();
		if (!model || !sessionId || generation !== sessionGeneration) return;
		const settings = loadModelSettings(model, ctx.cwd);
		if (
			!settings.enabled
			|| !settings.modelProfile?.effective.enabled
			|| !settings.providerShimActive
			|| !settings.openaiWebSocketPrewarm
			|| settings.openaiTransport === "sse"
		) {
			return;
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (
			startupSignal.aborted
			|| generation !== sessionGeneration
			|| !auth.ok
			|| !hasCodexRequestAuth({
				modelHeaders: model.headers,
				auth: { apiKey: auth.apiKey, headers: auth.headers },
			})
		) {
			return;
		}

		const profile = resolveCodexRequestProfile(settings.requestProfile);
		const requestIdentity = resolveCodexRequestIdentity(
			sessionId,
			undefined,
			"prewarm",
		);
		// Match Codex startup prewarm: snapshot only stable request context.
		// Conversation history and the first user message are sent by the first
		// real request as an incremental continuation from this response.
		let body = applyFastModeServiceTier(
			buildRequestBody(model, {
				systemPrompt: snapshot.systemPrompt,
				messages: [],
				tools: snapshot.tools,
			}, profile, {
				ownsNativeTool,
				apiKey: auth.apiKey,
				headers: auth.headers,
				sessionId,
				reasoning: snapshot.reasoning ?? (model.reasoning ? "medium" : undefined),
			}),
			settings,
			model,
		);
		if (settings.nativeProviderTools) {
			const webSearch = settings.modelProfile.effective.tools.webSearch;
			body = rewriteNativeOpenAiTools(body, {
				ownsNativeTool,
				imageModel: settings.imageModel,
				imageGeneration: settings.imageGenerationImplementation ?? false,
				webSearch: settings.webSearchEnabled && webSearch
					? {
							implementation: webSearch.implementation,
							contentTypes: webSearch.contentTypes,
						}
					: false,
			}).payload;
		}
		ensureWebSearchDetailsIncluded(body);
		body = withResponsesLiteWebSocketMetadata(body, profile.responsesMode);

		const websocketUrl = resolveResponsesWebSocketUrl(model.baseUrl, { apiKeyMode: settings.apiKeyMode });
		const fallbackKey = webSocketFallbackKey(
			sessionId,
			model,
			websocketUrl,
			settings.modelProfileHash,
		);
		if (settings.openaiTransport === "auto" && fallbackKey && websocketHttpFallbackSessions.has(fallbackKey)) {
			return;
		}
		if (startupSignal.aborted || generation !== sessionGeneration) return;
		const headers = applyConfiguredResponsesFeatureHeaders(buildWebSocketHeaders(
			model.headers,
			auth.headers,
			resolveCodexRequestAccountId({
				modelHeaders: model.headers,
				auth: { apiKey: auth.apiKey, headers: auth.headers },
				apiKeyMode: settings.apiKeyMode,
			}),
			auth.apiKey ?? "",
			sessionId,
			requestIdentity?.threadId ?? sessionId,
			requestIdentity,
		), settings, model);
		const cacheKey = webSocketCacheKey(
			sessionId,
			model,
			websocketUrl,
			headers,
			settings.modelProfileHash,
		);
		if (
			!cacheKey
			|| startupSignal.aborted
			|| generation !== sessionGeneration
			|| startupPrewarms.has(cacheKey)
		) {
			return;
		}
		if (websocketSessionCache.get(cacheKey)?.continuation) return;

		const abortController = new AbortController();
		const abortFromSession = () => abortController.abort();
		startupSignal.addEventListener("abort", abortFromSession, { once: true });
		const state: StartupPrewarmState = {
			status: "pending",
			abortController,
			promise: Promise.resolve(),
		};
		startupPrewarms.set(cacheKey, state);
		const timeout = setTimeout(() => abortController.abort(), WEBSOCKET_PREWARM_TIMEOUT_MS);
		state.promise = prewarmWebSocket({
			url: websocketUrl,
			headers,
			cacheKey,
			body,
			requestMetadata: {
				sessionId,
				threadId: requestIdentity?.threadId ?? sessionId,
				turnId: requestIdentity?.turnId ?? "",
				requestKind: "prewarm",
				...(requestIdentity ? { identity: requestIdentity } : {}),
			},
			signal: abortController.signal,
			connectTimeoutMs: WEBSOCKET_PREWARM_TIMEOUT_MS,
		})
			.then(() => {
				state.status = "ready";
			})
			.catch((error) => {
				state.status = "failed";
				if (
					!startupSignal.aborted
					&& generation === sessionGeneration
					&& settings.openaiTransport === "auto"
					&& fallbackKey
					&& isWebSocketUpgradeRejectedError(error)
				) {
					websocketHttpFallbackSessions.add(fallbackKey);
				}
			})
			.finally(() => {
				clearTimeout(timeout);
				startupSignal.removeEventListener("abort", abortFromSession);
			});
		await state.promise;
	})();

	const start = (ctx: ExtensionContext) => {
		const generation = sessionGeneration;
		// Do not block session startup. The first provider request naturally
		// serializes behind this socket operation if it is still pending.
		const model = ctx?.model as Model<Api> | undefined;
		const sessionId = ctx?.sessionManager?.getSessionId?.();
		if (model && sessionId) {
			const abortController = new AbortController();
			const snapshot = startupPrewarmSnapshot(pi, ctx);
			// Prewarm is speculative. Auth/request preparation failures must not
			// escape as unhandled promises or prevent the real request from running.
			const promise = settleSpeculativeTask(
				scheduleStartupPrewarm(ctx, generation, abortController.signal, snapshot),
				abortController.signal,
			);
			sessionStartupPrewarmTasks.set(sessionId, {
				generation,
				modelIdentity: modelIdentity(model),
				promise,
				abortController,
			});
			void promise;
		}
	};

	return {
		reset,
		start,
		get(sessionId: string, requestModel: Model<Api>): Promise<void> | undefined {
			const task = sessionStartupPrewarmTasks.get(sessionId);
			return task
				&& task.generation === sessionGeneration
				&& task.modelIdentity === modelIdentity(requestModel)
				? task.promise
				: undefined;
		},
	};
}
