import { type ProviderHeaders } from "@earendil-works/pi-ai";
import { appendAssistantMessageDiagnostic, createAssistantMessageDiagnostic, createAssistantMessageEventStream, type Api, type AssistantMessageEventStream, type Context, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { hasCodexRequestAuth, resolveCodexRequestAccountId } from "@oai404iao/pi-codex-runtime/internal/codex-http";
import { resolveCodexRequestProfile } from "@oai404iao/pi-codex-runtime/internal/codex-request-profile";
import { captureCodexTurnState, resolveCodexRequestIdentity } from "@oai404iao/pi-codex-runtime/internal/codex-wire-identity";
import { applyFastModeServiceTier } from "../../fast-mode.js";
import { loadModelSettings } from "@oai404iao/pi-codex-runtime/internal/model-catalog/runtime";
import { rewriteNativeOpenAiTools, type NativeToolRewriteOptions } from "../../provider-native-tools.js";
import { collectHistoricalCitationSources, collectWebSearchCitationSources } from "@oai404iao/pi-codex-runtime/internal/providers/responses/citations";
import { responseGrammarProperties } from "@oai404iao/pi-codex-runtime/internal/providers/responses/grammar";
import { webSocketFallbackKey } from "./cache-key.js";
import { processCapturedResponsesStream } from "./captured-stream.js";
import type { ProviderStreamEffects } from "@oai404iao/pi-codex-runtime/internal/providers/openai-codex/stream-effects";
import { NonRetryableProviderError, ProviderStreamEventCallbackError, isRetryableError, isTerminalQuotaError, parseErrorResponse, withHttpStatusPrefix } from "./errors.js";
import { applyConfiguredResponsesFeatureHeaders, buildSSEHeaders, buildWebSocketHeaders, headersToRecord, providerHeadersToHeaders } from "./headers.js";
import { withResponsesLiteWebSocketMetadata } from "./lite.js";
import { assertSuccessfulOutput, createErrorMessage, createInitialAssistantMessage } from "./message.js";
import { proxyDispatcherForUrl } from "./proxy.js";
import { buildRequestBody, ensureWebSearchDetailsIncluded, requestBodyToolOptions } from "./request-body.js";
import { getLatestUserText } from "./request-context.js";
import { createCodexRequestId, createPiTurnId, withSseRequestMetadata } from "./request-metadata.js";
import { isProviderNonTransportError, isRetryableWebSocketError, isWebSocketConnectionLimitReachedError, isWebSocketUpgradeRejectedError, sleep, sseMaxRetries, sseRetryDelayMs, webSocketRetryDelayMs, webSocketStreamMaxRetries } from "./retry.js";
import { fetchWithResponseHeaderTimeout, parseSSE, responseHeaderTimeoutMsFromOptions } from "./sse.js";
import { type ProviderTransport, type ResponsesBody, type WebSocketRequestMetadata } from "@oai404iao/pi-codex-runtime/internal/providers/openai-codex/types";
import { resolveResponsesUrl, resolveResponsesWebSocketUrl } from "./urls.js";
import { finalizeUsage, withRequestServiceTier } from "./usage.js";
import { websocketHttpFallbackSessions } from "./websocket-session.js";
import { processWebSocketStream } from "./websocket-stream.js";
import { prepareSseBody } from "./request-compression.js";
import { assertOpaqueReplayAllowed, reportHostedFailure } from "./endpoint-policy.js";
import { rememberResolvedEndpoint } from "@oai404iao/pi-codex-runtime/internal/endpoint-state";

export function createCodexStream<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	deps: ProviderStreamEffects & Pick<NativeToolRewriteOptions, "ownsNativeTool"> & {
		getCurrentCwd: () => string;
		configuredModel?: Model<Api>;
		getCurrentTurnId?: (sessionId: string | undefined) => string | undefined;
		getStartupPrewarm?: (sessionId: string, model: Model<Api>) => Promise<void> | undefined;
	},
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const requestCwd = deps.getCurrentCwd();

	(async () => {
		const output = createInitialAssistantMessage(model);
		const requestPrompt = getLatestUserText(context);
		const webSearchCitationSources = collectWebSearchCitationSources(model, context);
		const historicalCitationSources = collectHistoricalCitationSources(model, context);
		let sentBody: ResponsesBody | undefined;

		try {
			const apiKey = options?.apiKey ?? "";
			const requestHeaders = options?.headers;
			const auth = { apiKey: apiKey || undefined, headers: requestHeaders };
			if (!hasCodexRequestAuth({ modelHeaders: model.headers, auth })) {
				throw new Error(`No request authentication for provider: ${model.provider}`);
			}

			rememberResolvedEndpoint(deps.configuredModel ?? model, model, options?.sessionId);
			const settings = loadModelSettings(model, requestCwd, undefined, options?.sessionId);
			if (settings.requestBlockedReason) throw new Error(settings.requestBlockedReason);
			const requestProfile = resolveCodexRequestProfile(settings.requestProfile);
			if (
				!settings.enabled
				|| !settings.modelProfile?.effective.enabled
				|| !settings.providerShimActive
			) {
				throw new Error(`No enabled Codex model profile for ${model.provider}/${model.id}`);
			}
			const endpoint = settings.responsesEndpoint;
			const accountId = resolveCodexRequestAccountId({
				modelHeaders: model.headers,
				auth,
				endpoint,
			});
			let requestIdentity = !settings.codexRequestExtensions ? undefined : resolveCodexRequestIdentity(
				options?.sessionId,
				options?.metadata as Record<string, unknown> | undefined,
				"turn",
			);
			let body = applyFastModeServiceTier(
				buildRequestBody(model, context, requestProfile, {
					...options,
					...requestBodyToolOptions(settings),
					requestIdentity,
					ownsNativeTool: deps.ownsNativeTool,
				}),
				settings,
				model,
				(options as { serviceTier?: string } | undefined)?.serviceTier,
			);
			const webSearch = settings.modelProfile.effective.tools.webSearch;
			body = rewriteNativeOpenAiTools(body, {
				...requestBodyToolOptions(settings),
				ownsNativeTool: deps.ownsNativeTool,
				webSearch: settings.webSearchEnabled && webSearch ? webSearch : false,
			}).payload;
			const nextBody = await options?.onPayload?.(body, model);
			if (nextBody !== undefined) {
				body = nextBody as ResponsesBody;
			}
			if (requestIdentity) requestIdentity = {
				...requestIdentity, model: typeof body.model === "string" && body.model.trim() ? body.model : model.id,
				reasoningEffort: body.reasoning?.effort,
			};
			options = withRequestServiceTier(options, body.service_tier);
			ensureWebSearchDetailsIncluded(body);
			assertOpaqueReplayAllowed(body, settings);
			sentBody = body;
			const grammarToolInputProperties = responseGrammarProperties(body, context.tools);

			const websocketSessionId = requestIdentity?.sessionId ?? options?.sessionId;
			const websocketThreadId = requestIdentity?.threadId ?? options?.sessionId;
			const websocketTurnId = requestIdentity?.turnId
				|| deps.getCurrentTurnId?.(options?.sessionId)
				|| createPiTurnId();
			const websocketRequestId = websocketThreadId
				|| websocketSessionId
				|| createCodexRequestId();
			const websocketRequestMetadata: WebSocketRequestMetadata = {
				codexRequestExtensions: settings.codexRequestExtensions,
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
					settings.codexRequestExtensions,
					endpoint,
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
				settings.codexRequestExtensions,
				endpoint,
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
			// Pi exposes a session transport setting through stream options. When
			// the global gate permits WebSocket, explicit non-auto values override
			// the model profile.
			const transport: ProviderTransport = !settings.webSocketEnabled
				? "sse"
				: options?.transport && options.transport !== "auto"
					? options.transport
					: configuredTransport;

			const websocketUrl = resolveResponsesWebSocketUrl(model.baseUrl, endpoint);
			const fallbackKey = webSocketFallbackKey(
				options?.cacheRetention === "none" ? undefined : options?.sessionId,
				model as Model<Api>,
				websocketUrl,
				settings.modelProfileHash,
				options?.env,
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
				const startupPrewarmTask = options?.sessionId && options.cacheRetention !== "none"
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
							grammarToolInputProperties,
						);
						if (options?.signal?.aborted) {
							throw new Error("Request was aborted");
						}
						finalizeUsage(model, output);
						assertSuccessfulOutput(output);
						stream.push({ type: "done", reason: output.stopReason, message: output });
						stream.end();
						return;
					} catch (error) {
						if (error instanceof ProviderStreamEventCallbackError) throw error;
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
			const sseUrl = resolveResponsesUrl(model.baseUrl, endpoint);
			const sseDispatcher = options?.fetch ? undefined : await proxyDispatcherForUrl(sseUrl, options?.env);
			if (transformHeaders) {
				sseHeaders = providerHeadersToHeaders(
					await transformHeaders(headersToRecord(sseHeaders)),
				);
			}

			const sseBody = prepareSseBody(sseUrl, bodyJson, sseHeaders, model.provider);
			const maxRetries = sseMaxRetries(options);
			for (let attempt = 0; attempt <= maxRetries; attempt++) {
				if (options?.signal?.aborted) {
					throw new Error("Request was aborted");
				}

				try {
					response = await fetchWithResponseHeaderTimeout(sseUrl, {
						method: "POST",
						headers: sseHeaders,
						body: sseBody,
						...(sseDispatcher ? { dispatcher: sseDispatcher } : {}),
					} as RequestInit, options?.signal, responseHeaderTimeoutMs, options?.fetch);

					await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);

					if (response.ok) {
						if (options?.sessionId && settings.codexRequestExtensions) {
							captureCodexTurnState(
								options.sessionId,
								response.headers.get("x-codex-turn-state") ?? undefined,
							);
						}
						break;
					}

					const errorText = await response.text();
					const rejected = !options?.signal?.aborted && reportHostedFailure(model, options?.sessionId, body, { status: response.status, responseBody: errorText }, deps.ownsNativeTool);
					if (!rejected && attempt < maxRetries && isRetryableError(response.status, errorText)) {
						await sleep(sseRetryDelayMs(attempt, options, headersToRecord(response.headers)), options?.signal);
						continue;
					}

					const fakeResponse = new Response(errorText, {
						status: response.status,
						statusText: response.statusText,
					});
					const info = await parseErrorResponse(fakeResponse);
					throw Object.assign(new NonRetryableProviderError(withHttpStatusPrefix(response.status, info.friendlyMessage || info.message)), {
						status: response.status, responseBody: errorText,
					});
				} catch (error) {
					if (error instanceof NonRetryableProviderError) {
						throw error;
					}
					if (error instanceof Error && (error.name === "AbortError" || error.message === "Request was aborted")) {
						throw new Error("Request was aborted");
					}

					lastError = error instanceof Error ? error : new Error(String(error));
					if (attempt < maxRetries && !lastError.message.includes("usage limit") && !isTerminalQuotaError(lastError.message)) {
						await sleep(sseRetryDelayMs(attempt, options), options?.signal);
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
				parseSSE(response, options?.signal),
				output,
				stream,
				model,
				options,
				settings.codexRequestExtensions ? options?.sessionId : undefined,
				deps,
				requestCwd,
				requestPrompt,
				webSearchCitationSources,
				historicalCitationSources,
				grammarToolInputProperties,
			);
			finalizeUsage(model, output);

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			assertSuccessfulOutput(output);
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			if (!options?.signal?.aborted && !(error instanceof ProviderStreamEventCallbackError)) reportHostedFailure(model, options?.sessionId, sentBody, error, deps.ownsNativeTool);
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
