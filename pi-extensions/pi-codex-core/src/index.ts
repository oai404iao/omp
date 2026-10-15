import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { hasConfiguredModelsLoaded } from "@oai404iao/pi-codex-runtime/internal/activation";

import {
	computeToolCapabilities,
	modelKey,
	type ModelLike,
} from "@oai404iao/pi-codex-runtime/internal/capabilities";

import { resolveCodexRequestProfile } from "@oai404iao/pi-codex-runtime/internal/codex-request-profile";

import { registerFastMode, resolveFastModeServiceTier } from "./fast-mode.js";

import {
	modelCatalogDiagnostics,
	modelsPath,
	resolveModelProfile,
} from "@oai404iao/pi-codex-runtime/internal/model-catalog/catalog";

import { loadModelSettings } from "@oai404iao/pi-codex-runtime/internal/model-catalog/runtime";
import { knownEndpointModel } from "@oai404iao/pi-codex-runtime/internal/endpoint-state";

import { registerNativeCompaction } from "./native-compaction.js";

import { rewriteNativeOpenAiTools } from "./provider-native-tools.js";

import { configPath, loadSettings, settingsDiagnostics } from "@oai404iao/pi-codex-runtime/internal/settings";

import { ensureCodexServices } from "@oai404iao/pi-codex-runtime";
import { ownsRegisteredTool, snapshotOwnedToolProtocols } from "@oai404iao/pi-codex-runtime/internal/tool-activation";

import { registerResponsesProviderRuntime } from "./extension/provider-runtime.js";



function contextModel(ctx: ExtensionContext): ModelLike | undefined {
	return ctx.model as ModelLike | undefined;
}

function statusLines(pi: ExtensionAPI, ctx: ExtensionContext): string[] {
	const settings = loadSettings(ctx.cwd);
	const model = contextModel(ctx);
	const policyModel = knownEndpointModel(model ?? {}, ctx.sessionManager?.getSessionId?.());
	const modelSettings = loadModelSettings(policyModel, ctx.cwd, settings, ctx.sessionManager?.getSessionId?.());
	const capabilities = computeToolCapabilities(policyModel, settings);
	const requestProfile = resolveCodexRequestProfile(modelSettings.requestProfile);
	const modelProfile = modelSettings.modelProfile;
	const active = new Set(pi.getActiveTools?.() ?? []);
	const fastModeTier = resolveFastModeServiceTier(modelSettings, model);
	return [
		"Codex Minimal Tools",
		`model: ${modelKey(model)}`,
		`config: ${configPath()}`,
		`models: ${modelsPath()}`,
		`model profile: ${modelProfile ? `${modelProfile.sources.join("+")} #${modelProfile.profileHash}` : "(none)"}`,
		`configured models loaded: ${hasConfiguredModelsLoaded(ctx, settings)}`,
		`enabled: ${settings.enabled}`,
		`Codex request extensions: ${settings.codexRequestExtensions}`,
		`endpoint declarations: ${settings.endpoint_config.length}`,
		`endpoint policy: ${policyModel.baseUrl ? "resolved by Pi authentication" : "awaiting request authentication"}`,
		`autoEnable: ${settings.autoEnable}`,
		`provider shim: ${modelSettings.providerShimActive ? "active" : "inactive"}`,
		`responses endpoint: ${modelSettings.responsesEndpoint}`,
		`Responses WebSocket enabled: ${settings.webSocketEnabled}`,
		`responses transport: ${modelSettings.openaiTransport}`,
		`Responses WebSocket prewarm: ${modelSettings.openaiWebSocketPrewarm}`,
		`fast mode: ${modelSettings.fastMode ? modelSettings.fastServiceTier ?? "on (unsupported)" : "off"}${fastModeTier ? ", active" : ""}`,
		`compaction: ${modelSettings.compactionMode}`,
		`request profile: ${requestProfile.responsesMode}/${requestProfile.patchTransport}, summary=${requestProfile.reasoningSummary}, system=${requestProfile.systemPromptPlacement}, hosted=${requestProfile.supportsHostedTools}, parallel=${requestProfile.supportsParallelTools}`,
		`web search: ${modelSettings.webSearchImplementation ?? "off"}`,
		`image generation: ${settings.imageGeneration ? modelSettings.imageGenerationImplementation ?? "off" : "off (global gate)"}`,
		`legacy additionalModelIds: ${settings.additionalModelIds.length > 0 ? settings.additionalModelIds.join(", ") : "(none)"}`,
		`legacy apiKeyMode: ${settings.apiKeyMode} (ignored outside openai-codex)`,
		...modelSettings.requestDiagnostics.map((line) => `warning: ${line}`),
		`native provider shim: ${settings.enabled ? "registered" : "disabled"}`,
		"tools:",
		...Object.entries(capabilities).map(([name, capability]) => `- ${name}: ${capability.enabled ? "supported" : "disabled"}${active.has(name) ? ", active" : ""} — ${capability.reason}`),
	];
}

function registerDiagnosticCommand(pi: ExtensionAPI): void {
	const showDoctor = (ctx: ExtensionCommandContext) => {
		const settings = loadSettings(ctx.cwd);
		const lines = statusLines(pi, ctx as ExtensionContext);
		lines.push(`image output dir: ${settings.imageOutputDir}`);
		const provider = contextModel(ctx)?.provider;
		const auth = provider ? ctx.modelRegistry?.getProviderAuthStatus?.(provider) : undefined;
		lines.push(`authentication: Pi managed${auth ? ` (${auth.source ?? "unconfigured"})` : ""}`);
		const diagnostics = settingsDiagnostics();
		if (diagnostics.length > 0) lines.push("settings diagnostics:", ...diagnostics.map((line) => `- ${line}`));
		const catalogDiagnostics = modelCatalogDiagnostics();
		if (catalogDiagnostics.length > 0) lines.push("model catalog diagnostics:", ...catalogDiagnostics.map((line) => `- ${line}`));
		const profileDiagnostics = loadModelSettings(contextModel(ctx), ctx.cwd, settings)
			.modelProfile?.diagnostics
			.filter((line) => !catalogDiagnostics.includes(line)) ?? [];
		if (profileDiagnostics.length > 0) {
			lines.push("active model profile diagnostics:", ...profileDiagnostics.map((line) => `- ${line}`));
		}
		ctx.ui.notify(lines.join("\n"), "info");
	};
	pi.registerCommand("codex-minimal-tools", {
		description: "Show Codex Minimal Tools status. Usage: /codex-minimal-tools | /codex-minimal-tools:doctor",
		handler: async (args: string, ctx) => {
			const subcommand = args.trim().split(/\s+/, 1)[0]?.toLowerCase();
			if (subcommand === "doctor") {
				showDoctor(ctx);
				return;
			}
			if (!subcommand) {
				ctx.ui.notify(statusLines(pi, ctx as ExtensionContext).join("\n"), "info");
				return;
			}
			ctx.ui.notify(statusLines(pi, ctx as ExtensionContext).join("\n"), "info");
		},
	});
	pi.registerCommand("codex-minimal-tools:doctor", {
		description: "Run lightweight self-checks",
		handler: async (_args: string, ctx) => showDoctor(ctx),
	});
}

export default function codexCore(pi: ExtensionAPI): void {
	const broker = ensureCodexServices(pi);
	if (!broker.claim("package:core")) return;
	const ownsNativeTool = (name: "web_search" | "image_generation") => ownsRegisteredTool(pi, broker, name);
	const getToolProtocols = (tools?: Parameters<typeof snapshotOwnedToolProtocols>[2]) => snapshotOwnedToolProtocols(pi, broker, tools);
	let currentCwd = process.cwd();
	pi.on("session_start", (_event, ctx) => { currentCwd = ctx.cwd; });
	pi.on("model_select", (_event, ctx) => { currentCwd = ctx.cwd; });
	if (loadSettings(currentCwd).enabled) {
		const controller = registerResponsesProviderRuntime(pi, { getCurrentCwd: () => currentCwd, ownsNativeTool, getToolProtocols }, {
			// Shared services own presentation hooks even when core is absent.
			clear() {}, flush() {}, scheduleFlush() {}, registerRenderers() {},
			streamEffects: () => broker.presentation.streamEffects(),
		});
		broker.coreEnabled = true;
		broker.engine = {
			customTools: true, hostedWebSearch: true,
			supports(model) {
				const settings = loadModelSettings(model, currentCwd);
				return !broker.closed && settings.enabled && settings.providerShimActive === true
					&& settings.modelProfile?.effective.enabled === true
					&& (model.api === "openai-responses" || model.api === "openai-codex-responses")
					&& !settings.requestBlockedReason;
			},
		};
		registerNativeCompaction(pi, controller);
	}
	registerDiagnosticCommand(pi);
	registerFastMode(pi);


	pi.on("before_provider_request", (event, ctx) => {
		currentCwd = ctx.cwd;
		const settings = loadSettings(ctx.cwd);
		const model = contextModel(ctx);
		const modelSettings = loadModelSettings(knownEndpointModel(model ?? {}, ctx.sessionManager?.getSessionId?.()), ctx.cwd, settings, ctx.sessionManager?.getSessionId?.());
		const profile = resolveModelProfile(model, { settings });
		if (
			!settings.enabled
			|| !profile?.effective.enabled
			|| !modelSettings.providerShimActive
		) return undefined;
		const webSearch = profile.effective.tools.webSearch;
		const result = rewriteNativeOpenAiTools(event.payload, {
			removeWebSearch: modelSettings.endpointDisabledWebSearch,
			codexRequestExtensions: modelSettings.codexRequestExtensions,
			ownsNativeTool,
			imageGeneration: modelSettings.imageGenerationImplementation ?? false,
			webSearch: modelSettings.webSearchEnabled
				&& webSearch
				? webSearch
				: false,
		});
		return result.rewritten.length > 0 || result.removed.length > 0
			? result.payload
			: undefined;
	});
}
