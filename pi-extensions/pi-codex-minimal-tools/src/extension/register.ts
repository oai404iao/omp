import { streamSimpleOpenAICodexResponses, streamSimpleOpenAIResponses, type Api, type Context, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hasCodexRequestAuth, resolveCodexRequestAccountId } from "../codex-http.js";
import { installCodexIdentityLifecycle } from "../codex-identity-extension.js";
import { resolveCodexRequestProfile } from "../codex-request-profile.js";
import { currentCodexTurn, resolveCodexRequestIdentity } from "../codex-wire-identity.js";
import { applyFastModeServiceTier } from "../fast-mode.js";
import { loadModelSettings } from "../model-catalog/runtime.js";
import { rewriteNativeOpenAiTools } from "../provider-native-tools.js";
import { webSocketCacheKey, webSocketFallbackKey } from "../providers/openai-codex/cache-key.js";
import { WEBSOCKET_PREWARM_TIMEOUT_MS } from "../providers/openai-codex/constants.js";
import { applyConfiguredResponsesFeatureHeaders, buildWebSocketHeaders } from "../providers/openai-codex/headers.js";
import { withResponsesLiteWebSocketMetadata } from "../providers/openai-codex/lite.js";
import { prewarmWebSocket } from "../providers/openai-codex/prewarm.js";
import { buildRequestBody, ensureWebSearchDetailsIncluded } from "../providers/openai-codex/request-body.js";
import { isWebSocketUpgradeRejectedError } from "../providers/openai-codex/retry.js";
import { createCodexStream } from "../providers/openai-codex/stream.js";
import { type OpenAIResponsesProviderController, type SessionStartupPrewarmTask, type StartupPrewarmState } from "../providers/openai-codex/types.js";
import { resolveResponsesWebSocketUrl } from "../providers/openai-codex/urls.js";
import { closeProviderWebSocketSessions, websocketHttpFallbackSessions, websocketSessionCache } from "../providers/openai-codex/websocket-session.js";
import { makeCachedImagePreview, renderImageGenerationMessage } from "../tools/image-generation/preview.js";
import { buildGeneratedImageDisplayText } from "../tools/image-generation/storage.js";
import { IMAGE_SAVE_DISPLAY_MESSAGE_TYPE, type CachedImagePreview, type ImageDisplayMessageDetails, type PendingActivity } from "../tools/image-generation/types.js";
import { registerWebSearchActivityRenderer } from "../tools/web-search/render.js";
import { startupPrewarmSnapshot, type StartupPrewarmSnapshot } from "./prewarm-snapshot.js";

export function registerOpenAIResponsesProviders(
	pi: ExtensionAPI,
	options: { getCurrentCwd: () => string },
): OpenAIResponsesProviderController {
	installCodexIdentityLifecycle(pi);
	const pendingActivities: PendingActivity[] = [];
	const imagePreviewCache = new Map<string, CachedImagePreview>();
	const startupPrewarms = new Map<string, StartupPrewarmState>();
	const sessionStartupPrewarmTasks = new Map<string, SessionStartupPrewarmTask>();
	let sessionGeneration = 0;
	let pendingFlushTimer: ReturnType<typeof setTimeout> | undefined;

	const abortStartupPrewarms = () => {
		for (const state of startupPrewarms.values()) state.abortController.abort();
		for (const task of sessionStartupPrewarmTasks.values()) task.abortController.abort();
		startupPrewarms.clear();
		sessionStartupPrewarmTasks.clear();
	};

	const modelIdentity = (model: Model<Api>): string =>
		`${model.provider}\n${model.api}\n${model.id}\n${model.baseUrl}`;

	const scheduleStartupPrewarm = (
		ctx: any,
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
					settings.openaiTransport === "auto"
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

	const flushPendingMessages = () => {
		pendingFlushTimer = undefined;
		const activities = pendingActivities.splice(0, pendingActivities.length);

		for (const activity of activities) {
			imagePreviewCache.set(activity.savedImage.absolutePath, makeCachedImagePreview(activity.imageData.data, activity.imageData.mimeType));
			pi.sendMessage(
				{
					customType: IMAGE_SAVE_DISPLAY_MESSAGE_TYPE,
					content: [{ type: "text", text: buildGeneratedImageDisplayText(activity.savedImage, { expanded: false }) }],
					display: true,
					details: { savedImages: [activity.savedImage] } satisfies ImageDisplayMessageDetails,
				},
				{ triggerTurn: false },
			);
		}
	};

	const schedulePendingMessageFlush = () => {
		if (pendingFlushTimer || pendingActivities.length === 0) {
			return;
		}
		pendingFlushTimer = setTimeout(flushPendingMessages, 0);
	};

	const clearPendingMessages = () => {
		if (pendingFlushTimer) {
			clearTimeout(pendingFlushTimer);
			pendingFlushTimer = undefined;
		}
		pendingActivities.length = 0;
		imagePreviewCache.clear();
	};

	const streamSimple = <TApi extends Api>(model: Model<TApi>, context: Context, streamOptions?: SimpleStreamOptions) => {
		const settings = loadModelSettings(model, options.getCurrentCwd());
		if (
			!settings.enabled
			|| !settings.modelProfile?.effective.enabled
			|| !settings.providerShimActive
		) {
			return model.api === "openai-codex-responses"
				? streamSimpleOpenAICodexResponses(model as Model<"openai-codex-responses">, context, streamOptions)
				: streamSimpleOpenAIResponses(model as Model<"openai-responses">, context, streamOptions);
		}
		return createCodexStream(model, context, streamOptions, {
			getCurrentCwd: options.getCurrentCwd,
			getCurrentTurnId: (sessionId) =>
				currentCodexTurn(sessionId)?.turnId,
			getStartupPrewarm: (sessionId, requestModel) => {
				const task = sessionStartupPrewarmTasks.get(sessionId);
				return task
					&& task.generation === sessionGeneration
					&& task.modelIdentity === modelIdentity(requestModel)
					? task.promise
					: undefined;
			},
			onImageSaved: (savedImage, imageData) => {
				pendingActivities.push({ kind: "image", savedImage, imageData });
			},
		});
	};

	type CodexResponsesApi = "openai-responses" | "openai-codex-responses";
	const registeredProviderApis = new Map<string, CodexResponsesApi>();
	const registerProviderShim = (provider: string, api: CodexResponsesApi): void => {
		if (!provider || registeredProviderApis.get(provider) === api) return;
		pi.registerProvider(provider, { api, streamSimple });
		registeredProviderApis.set(provider, api);
	};
	const ensureProviderShimForModel = (model: Model<Api> | undefined, cwd?: string): void => {
		if (!model) return;
		const settings = loadModelSettings(model, cwd);
		if (
			!settings.enabled
			|| !settings.modelProfile?.effective.enabled
			|| !settings.providerShimActive
		) {
			return;
		}
		if (model.api === "openai-responses" || model.api === "openai-codex-responses") {
			registerProviderShim(model.provider, model.api as CodexResponsesApi);
		}
	};

	// Pi 0.75 dispatches extension streams by API type, while newer Pi versions
	// compose them per provider. Register both built-ins first. A user-defined
	// provider is registered only after Pi supplies an actual selected model, so
	// this extension never creates or overwrites its URL, auth, or model list.
	registerProviderShim("openai-codex", "openai-codex-responses");
	registerProviderShim("openai", "openai-responses");

	pi.on("session_start", async (_event, ctx) => {
		sessionGeneration++;
		abortStartupPrewarms();
		ensureProviderShimForModel(ctx?.model as Model<Api> | undefined, ctx?.cwd);
		clearPendingMessages();
		const generation = sessionGeneration;
		// Do not block session startup. The first provider request naturally
		// serializes behind this socket operation if it is still pending.
		const model = ctx?.model as Model<Api> | undefined;
		const sessionId = ctx?.sessionManager?.getSessionId?.();
		if (model && sessionId) {
			const abortController = new AbortController();
			const snapshot = startupPrewarmSnapshot(pi, ctx);
			const promise = scheduleStartupPrewarm(ctx, generation, abortController.signal, snapshot);
			sessionStartupPrewarmTasks.set(sessionId, {
				generation,
				modelIdentity: modelIdentity(model),
				promise,
				abortController,
			});
			void promise;
		}
	});

	pi.on("model_select", async (_event, ctx) => {
		ensureProviderShimForModel(ctx?.model as Model<Api> | undefined, ctx?.cwd);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		sessionGeneration++;
		abortStartupPrewarms();
		if (pendingActivities.length > 0) {
			flushPendingMessages();
		}
		closeProviderWebSocketSessions(
			ctx?.sessionManager?.getSessionId?.(),
		);
		clearPendingMessages();
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		ensureProviderShimForModel(ctx.model as Model<Api> | undefined, ctx.cwd);
	});

	pi.on("agent_end", async (_event, ctx) => {
		schedulePendingMessageFlush();
	});

	pi.registerMessageRenderer<ImageDisplayMessageDetails>(IMAGE_SAVE_DISPLAY_MESSAGE_TYPE, (message, options, theme) => {
		const savedImage = message.details?.savedImages?.[0];
		const textContent = typeof message.content === "string"
			? message.content
			: message.content
					.filter((item) => item.type === "text")
					.map((item) => item.text)
					.join("\n");
		return renderImageGenerationMessage(savedImage, textContent, options, theme, imagePreviewCache);
	});
	registerWebSearchActivityRenderer(pi);

	return {
		getCurrentTurnId(sessionId) {
			return currentCodexTurn(sessionId)?.turnId;
		},
		getRequestIdentity(sessionId, requestKind = "turn") {
			return resolveCodexRequestIdentity(sessionId, undefined, requestKind);
		},
	};
}
