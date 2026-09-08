import { type ProviderHeaders } from "@earendil-works/pi-ai";
import { appendAssistantMessageDiagnostic, createAssistantMessageDiagnostic, createAssistantMessageEventStream, getEnvApiKey, type Api, type AssistantMessageEventStream, type Context, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { hasCodexRequestAuth, resolveCodexRequestAccountId } from "../../codex-http.js";
import { resolveCodexRequestProfile } from "../../codex-request-profile.js";
import { captureCodexTurnState, resolveCodexRequestIdentity } from "../../codex-wire-identity.js";
import { applyFastModeServiceTier } from "../../fast-mode.js";
import { loadModelSettings } from "../../model-catalog/runtime.js";
import { rewriteNativeOpenAiTools } from "../../provider-native-tools.js";
import { type SavedGeneratedImage } from "../../tools/image-generation/types.js";
import { collectHistoricalCitationSources, collectWebSearchCitationSources } from "../responses/citations.js";
import { webSocketFallbackKey } from "./cache-key.js";
import { processCapturedResponsesStream } from "./captured-stream.js";
import { BASE_DELAY_MS, MAX_RETRIES } from "./constants.js";
import { NonRetryableProviderError, isRetryableError, parseErrorResponse, withHttpStatusPrefix } from "./errors.js";
import { applyConfiguredResponsesFeatureHeaders, buildSSEHeaders, buildWebSocketHeaders, headersToRecord, providerHeadersToHeaders } from "./headers.js";
import { withResponsesLiteWebSocketMetadata } from "./lite.js";
import { createErrorMessage, createInitialAssistantMessage } from "./message.js";
import { proxyDispatcherForUrl } from "./proxy.js";
import { buildRequestBody, ensureWebSearchDetailsIncluded } from "./request-body.js";
import { getLatestUserText } from "./request-context.js";
import { createCodexRequestId, createPiTurnId, withSseRequestMetadata } from "./request-metadata.js";
import { isProviderNonTransportError, isRetryableWebSocketError, isWebSocketConnectionLimitReachedError, isWebSocketUpgradeRejectedError, sleep, webSocketRetryDelayMs, webSocketStreamMaxRetries } from "./retry.js";
import { fetchWithResponseHeaderTimeout, parseSSE, responseHeaderTimeoutMsFromOptions } from "./sse.js";
import { type ProviderTransport, type ResponsesBody, type WebSocketRequestMetadata } from "./types.js";
import { resolveCodexUrl, resolveResponsesWebSocketUrl } from "./urls.js";
import { finalizeUsage, withRequestServiceTier } from "./usage.js";
import { websocketHttpFallbackSessions } from "./websocket-session.js";
import { processWebSocketStream } from "./websocket-stream.js";

export function createCodexStream<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	deps: {
		getCurrentCwd: () => string;
		getCurrentTurnId?: (sessionId: string | undefined) => string | undefined;
		getStartupPrewarm?: (sessionId: string, model: Model<Api>) => Promise<void> | undefined;
		onImageSaved?: (savedImage: SavedGeneratedImage, imageData: { data: string; mimeType: string }) => void;
	},
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const requestCwd = deps.getCurrentCwd();

	(async () => {
		const output = createInitialAssistantMessage(model);
		const requestPrompt = getLatestUserText(context);
		const webSearchCitationSources = collectWebSearchCitationSources(model, context);
		const historicalCitationSources = collectHistoricalCitationSources(model, context);

		try {
			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			const requestHeaders = options?.headers;
			const auth = { apiKey: apiKey || undefined, headers: requestHeaders };
			if (!hasCodexRequestAuth({ modelHeaders: model.headers, auth })) {
				throw new Error(`No request authentication for provider: ${model.provider}`);
			}

			const settings = loadModelSettings(model, requestCwd);
			const requestProfile = resolveCodexRequestProfile(settings.requestProfile);
			if (
				!settings.enabled
				|| !settings.modelProfile?.effective.enabled
				|| !settings.providerShimActive
			) {
				throw new Error(`No enabled Codex model profile for ${model.provider}/${model.id}`);
			}
			const apiKeyTransport = settings.apiKeyMode;
			const accountId = resolveCodexRequestAccountId({
				modelHeaders: model.headers,
				auth,
				apiKeyMode: apiKeyTransport,
			});
			const requestIdentity = resolveCodexRequestIdentity(
				options?.sessionId,
				options?.metadata as Record<string, unknown> | undefined,
				"turn",
			);
			let body = applyFastModeServiceTier(
				buildRequestBody(model, context, requestProfile, options),
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
			const nextBody = await options?.onPayload?.(body, model);
			if (nextBody !== undefined) {
				body = nextBody as ResponsesBody;
			}
			options = withRequestServiceTier(options, body.service_tier);
			ensureWebSearchDetailsIncluded(body);

			const websocketSessionId = requestIdentity?.sessionId ?? options?.sessionId;
			const websocketThreadId = requestIdentity?.threadId ?? options?.sessionId;
			const websocketTurnId = requestIdentity?.turnId
				|| deps.getCurrentTurnId?.(options?.sessionId)
				|| createPiTurnId();
			const websocketRequestId = websocketThreadId
				|| websocketSessionId
				|| createCodexRequestId();
			const websocketRequestMetadata: WebSocketRequestMetadata = {
				...(options?.sessionId ? { sessionId: options.sessionId } : {}),
				...(websocketThreadId ? { threadId: websocketThreadId } : {}),
				turnId: websocketTurnId,
				...(requestIdentity ? { identity: requestIdentity } : {}),
			};
			let sseHeaders = applyConfiguredResponsesFeatureHeaders(
				buildSSEHeaders(
					model.headers,
					requestHeaders,
					accountId,
					apiKey,
					options?.sessionId,
					requestProfile,
					websocketThreadId,
					requestIdentity,
				),
				settings,
				model as Model<Api>,
			);
			let websocketHeaders = applyConfiguredResponsesFeatureHeaders(buildWebSocketHeaders(
				model.headers,
				requestHeaders,
				accountId,
				apiKey,
				options?.sessionId ?? websocketRequestId,
				websocketThreadId ?? websocketRequestId,
				requestIdentity,
			), settings, model as Model<Api>);
			const transformHeaders = (
				options as
					| (SimpleStreamOptions & {
							transformHeaders?: (
								headers: ProviderHeaders,
							) => ProviderHeaders | Promise<ProviderHeaders>;
						})
					| undefined
			)?.transformHeaders;
			const bodyJson = JSON.stringify(withSseRequestMetadata(body, websocketRequestMetadata));
			const responseHeaderTimeoutMs = responseHeaderTimeoutMsFromOptions(options);
			const configuredTransport: ProviderTransport = settings.openaiTransport;
			// Pi exposes a session transport setting through stream options. Treat
			// explicit non-auto values as overrides; otherwise use the model profile.
			const transport: ProviderTransport = options?.transport && options.transport !== "auto"
				? options.transport
				: configuredTransport;

			const websocketUrl = resolveResponsesWebSocketUrl(model.baseUrl, { apiKeyMode: apiKeyTransport });
			const fallbackKey = webSocketFallbackKey(
				options?.sessionId,
				model as Model<Api>,
				websocketUrl,
				settings.modelProfileHash,
			);
			const sessionFellBackToHttp = transport === "auto"
				&& fallbackKey !== undefined
				&& websocketHttpFallbackSessions.has(fallbackKey);

			if (transport !== "sse" && !sessionFellBackToHttp) {
				if (transformHeaders) {
					websocketHeaders = providerHeadersToHeaders(
						await transformHeaders(
							headersToRecord(websocketHeaders),
						),
					);
				}
				const startupPrewarmTask = options?.sessionId
					? deps.getStartupPrewarm?.(options.sessionId, model as Model<Api>)
					: undefined;
				const websocketBody = withResponsesLiteWebSocketMetadata(body, requestProfile.responsesMode);
				let websocketStarted = false;
				let websocketRetries = 0;
				const maxWebSocketRetries = webSocketStreamMaxRetries(options);
				while (true) {
					websocketStarted = false;
					try {
						await processWebSocketStream(
							websocketUrl,
							websocketBody,
							websocketHeaders,
							output,
							stream,
							model,
							() => {
								websocketStarted = true;
							},
							options,
							deps,
							requestCwd,
							requestPrompt,
							webSearchCitationSources,
							historicalCitationSources,
							websocketRequestMetadata,
							settings.modelProfileHash,
							startupPrewarmTask,
						);
						if (options?.signal?.aborted) {
							throw new Error("Request was aborted");
						}
						finalizeUsage(model, output);
						stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
						stream.end();
						return;
					} catch (error) {
						const aborted = options?.signal?.aborted;
						const upgradeRejected = isWebSocketUpgradeRejectedError(error);
						if (
							transport === "auto"
							&& !websocketStarted
							&& upgradeRejected
						) {
							if (fallbackKey) websocketHttpFallbackSessions.add(fallbackKey);
							appendAssistantMessageDiagnostic(
								output,
								createAssistantMessageDiagnostic("provider_transport_failure", error, {
									configuredTransport,
									fallbackTransport: "sse",
									eventsEmitted: false,
									phase: "websocket_upgrade_rejected",
									retries: websocketRetries,
									requestBytes: new TextEncoder().encode(bodyJson).byteLength,
								}),
							);
							break;
						}
						const retryableTransport = !aborted
							&& (isWebSocketConnectionLimitReachedError(error) || isRetryableWebSocketError(error));
						const retryableBeforeStart = !websocketStarted && retryableTransport;
						if (retryableBeforeStart && websocketRetries < maxWebSocketRetries) {
							websocketRetries++;
							await sleep(webSocketRetryDelayMs(error, websocketRetries, options), options?.signal);
							continue;
						}
						if (aborted || (isProviderNonTransportError(error) && !isWebSocketConnectionLimitReachedError(error))) {
							throw error;
						}
						appendAssistantMessageDiagnostic(
							output,
							createAssistantMessageDiagnostic("provider_transport_failure", error, {
								configuredTransport,
								eventsEmitted: websocketStarted,
								phase: websocketStarted ? "after_message_stream_start" : "before_message_stream_start",
								retries: websocketRetries,
								requestBytes: new TextEncoder().encode(bodyJson).byteLength,
							}),
						);
						throw error;
					}
				}
			}

			let response: Response | undefined;
			let lastError: Error | undefined;
			const sseUrl = resolveCodexUrl(model.baseUrl, { apiKeyMode: apiKeyTransport });
			const sseDispatcher = await proxyDispatcherForUrl(sseUrl);
			if (transformHeaders) {
				sseHeaders = providerHeadersToHeaders(
					await transformHeaders(headersToRecord(sseHeaders)),
				);
			}

			for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
				if (options?.signal?.aborted) {
					throw new Error("Request was aborted");
				}

				try {
					response = await fetchWithResponseHeaderTimeout(sseUrl, {
						method: "POST",
						headers: sseHeaders,
						body: bodyJson,
						...(sseDispatcher ? { dispatcher: sseDispatcher } : {}),
					} as RequestInit, options?.signal, responseHeaderTimeoutMs);

					await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);

					if (response.ok) {
						if (options?.sessionId) {
							captureCodexTurnState(
								options.sessionId,
								response.headers.get("x-codex-turn-state") ?? undefined,
							);
						}
						break;
					}

					const errorText = await response.text();
					if (attempt < MAX_RETRIES && isRetryableError(response.status, errorText)) {
						await sleep(BASE_DELAY_MS * 2 ** attempt, options?.signal);
						continue;
					}

					const fakeResponse = new Response(errorText, {
						status: response.status,
						statusText: response.statusText,
					});
					const info = await parseErrorResponse(fakeResponse);
					throw new NonRetryableProviderError(withHttpStatusPrefix(response.status, info.friendlyMessage || info.message));
				} catch (error) {
					if (error instanceof NonRetryableProviderError) {
						throw error;
					}
					if (error instanceof Error && (error.name === "AbortError" || error.message === "Request was aborted")) {
						throw new Error("Request was aborted");
					}

					lastError = error instanceof Error ? error : new Error(String(error));
					if (attempt < MAX_RETRIES && !lastError.message.includes("usage limit")) {
						await sleep(BASE_DELAY_MS * 2 ** attempt, options?.signal);
						continue;
					}
					throw lastError;
				}
			}

			if (!response?.ok) {
				throw lastError ?? new Error("Failed after retries");
			}

			if (!response.body) {
				throw new Error("No response body");
			}

			stream.push({ type: "start", partial: output });
			await processCapturedResponsesStream(
				parseSSE(response),
				output,
				stream,
				model,
				options,
				options?.sessionId,
				deps,
				requestCwd,
				requestPrompt,
				webSearchCitationSources,
				historicalCitationSources,
			);
			finalizeUsage(model, output);

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
			stream.end();
		} catch (error) {
			stream.push({
				type: "error",
				reason: (options?.signal?.aborted ? "aborted" : "error") as "aborted" | "error",
				error: createErrorMessage(output, error, !!options?.signal?.aborted),
			});
			stream.end();
		}
	})();

	return stream;
}
