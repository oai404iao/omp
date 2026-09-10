import {
	streamSimpleOpenAICodexResponses, streamSimpleOpenAIResponses,
	type Api, type Context, type Model, type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installCodexIdentityLifecycle } from "@oai404iao/pi-codex-runtime/internal/codex-identity-extension";
import { currentCodexTurn, resolveCodexRequestIdentity } from "@oai404iao/pi-codex-runtime/internal/codex-wire-identity";
import { loadModelSettings } from "@oai404iao/pi-codex-runtime/internal/model-catalog/runtime";
import { createCodexStream } from "../providers/openai-codex/stream.js";
import { createSupplementalOpenAICodexProvider } from "../providers/openai-codex/model-catalog.js";
import type { OpenAIResponsesProviderController } from "@oai404iao/pi-codex-runtime/internal/providers/openai-codex/types";
import { closeProviderWebSocketSessions } from "../providers/openai-codex/websocket-session.js";
import type { ProviderPresentation } from "@oai404iao/pi-codex-runtime/internal/extension/provider-presentation";
import { createStartupPrewarmLifecycle } from "./startup-prewarm.js";

export function registerResponsesProviderRuntime(
	pi: ExtensionAPI,
	options: { getCurrentCwd: () => string; ownsNativeTool?: OpenAIResponsesProviderController["ownsNativeTool"] },
	presentation?: ProviderPresentation,
): OpenAIResponsesProviderController {
	installCodexIdentityLifecycle(pi);
	const prewarm = createStartupPrewarmLifecycle(pi, options.ownsNativeTool);
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
			ownsNativeTool: options.ownsNativeTool,
			...presentation?.streamEffects(),
			getCurrentCwd: options.getCurrentCwd,
			getCurrentTurnId: (sessionId) => currentCodexTurn(sessionId)?.turnId,
			getStartupPrewarm: prewarm.get,
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

	// Register built-ins first; custom providers require an actual selected
	// model so their URL, auth and model list are never created or overwritten.
	const supplementalCodexProvider = createSupplementalOpenAICodexProvider(streamSimple);
	if (supplementalCodexProvider) {
		pi.registerProvider(supplementalCodexProvider);
		registeredProviderApis.set("openai-codex", "openai-codex-responses");
	} else {
		registerProviderShim("openai-codex", "openai-codex-responses");
	}
	registerProviderShim("openai", "openai-responses");

	pi.on("session_start", async (_event, ctx) => {
		prewarm.reset();
		ensureProviderShimForModel(ctx?.model as Model<Api> | undefined, ctx?.cwd);
		presentation?.clear();
		prewarm.start(ctx);
	});
	pi.on("model_select", async (_event, ctx) => {
		ensureProviderShimForModel(ctx?.model as Model<Api> | undefined, ctx?.cwd);
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		prewarm.reset();
		presentation?.flush();
		closeProviderWebSocketSessions(ctx?.sessionManager?.getSessionId?.());
		presentation?.clear();
	});
	pi.on("before_agent_start", async (_event, ctx) => {
		ensureProviderShimForModel(ctx.model as Model<Api> | undefined, ctx.cwd);
	});
	pi.on("agent_end", async () => {
		presentation?.scheduleFlush();
	});
	presentation?.registerRenderers();

	return {
		ownsNativeTool: options.ownsNativeTool,
		getCurrentTurnId(sessionId) {
			return currentCodexTurn(sessionId)?.turnId;
		},
		getRequestIdentity(sessionId, requestKind = "turn") {
			return resolveCodexRequestIdentity(sessionId, undefined, requestKind);
		},
	};
}
