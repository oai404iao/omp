import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCapabilities, Image, Text, type Component } from "@earendil-works/pi-tui";
import { hasConfiguredModelsLoaded } from "./activation.js";
import { registerBackgroundImageGenerationCommand } from "./background-image-generation.js";
import {
	computeNextActiveTools,
	computeToolCapabilities,
	modelKey,
	NATIVE_MUTATION_TOOL_NAMES,
	PACKAGE_TOOL_NAMES,
	type ModelLike,
	type NativeMutationToolName,
} from "./capabilities.js";
import {
	registerOpenAIResponsesProviders,
	type OpenAIResponsesProviderController,
} from "./provider-shim.js";
import { rewriteNativeOpenAiTools } from "./provider-native-tools.js";
import { configPath, loadSettings, settingsDiagnostics } from "./settings.js";
import {
	modelCatalogDiagnostics,
	modelsPath,
	resolveModelProfile,
} from "./model-catalog/catalog.js";
import { loadModelSettings } from "./model-catalog/runtime.js";
import { createApplyPatchToolDefinition } from "./tools/apply-patch.js";
import { createImageGenerationToolDefinition } from "./tools/image-generation.js";
import { createWebSearchToolDefinition } from "./tools/web-search.js";
import { viewImage, viewImageToolSchema, type ValidatedImage, type ViewImageInput } from "./tools/view-image.js";
import { glyphs } from "./glyphs.js";
import { resolveCodexRequestProfile } from "./codex-request-profile.js";
import { registerNativeCompaction } from "./native-compaction.js";
import { registerFastMode, resolveFastModeServiceTier } from "./fast-mode.js";

const INSTALL_SYMBOL = Symbol.for("pi-codex-minimal-tools.installed");

function terminalImageProtocol(): "kitty" | "iterm2" | null {
	return getCapabilities().images ?? null;
}

function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10}K`;
	return `${Math.round(bytes / (1024 * 102.4)) / 10}M`;
}

function viewImageCallText(args: ViewImageInput | undefined, theme: any): string {
	const path = typeof args?.path === "string" ? args.path : "image";
	const detail = args?.detail && args.detail !== "auto" ? ` ${theme.fg("dim", `${glyphs().dot.trim()} ${args.detail}`)}` : "";
	return `${theme.fg("accent", glyphs().bullet)}${theme.fg("text", theme.bold("View Image "))}${theme.fg("accent", path)}${detail}`;
}

function viewImageResultText(details: ValidatedImage | undefined, theme: any): string {
	if (!details) return `${theme.fg("accent", glyphs().bullet)}${theme.fg("text", theme.bold("View Image"))}${theme.fg("dim", `${glyphs().dot}image loaded`)}`;
	const type = details.mimeType.replace(/^image\//, "").toUpperCase();
	const protocol = terminalImageProtocol();
	const preview = protocol ? theme.fg("success", `inline ${protocol}`) : theme.fg("warning", "fallback");
	return `${theme.fg("accent", glyphs().bullet)}${theme.fg("text", theme.bold("View Image "))}${theme.fg("accent", details.displayPath)}${theme.fg("dim", glyphs().dot)}${theme.fg("success", type)}${theme.fg("dim", `${glyphs().dot}${formatBytes(details.sizeBytes)}${glyphs().dot}`)}${preview}`;
}

function emptyComponent(): Component {
	return { invalidate() {}, render: () => [] };
}

function textComponent(text: string): Component {
	return new Text(text, 0, 0);
}

function viewImageResultComponent(result: any, options: any, theme: any, context: any): Component {
	if (options?.isPartial) return emptyComponent();
	const details = result?.details as ValidatedImage | undefined;
	const imagePart = result?.content?.find?.((part: any) => part?.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string");
	const header = textComponent(viewImageResultText(details, theme));
	if (!imagePart) return header;
	const imageTheme = { fallbackColor: (text: string) => theme.fg("dim", text) };
	const maxHeightCells = options?.expanded ? 28 : 18;
	const image = new Image(imagePart.data, imagePart.mimeType, imageTheme, { maxWidthCells: 80, maxHeightCells, filename: details?.displayPath });
	return {
		invalidate() {
			header.invalidate();
			image.invalidate();
		},
		render(width: number): string[] {
			return [...header.render(width), ...image.render(width)];
		},
	};
}

function contextModel(ctx: ExtensionContext): ModelLike | undefined {
	return ctx.model as ModelLike | undefined;
}

type SuppressedMutationTools = Map<NativeMutationToolName, number>;

function captureSuppressedMutationTools(
	activeTools: readonly string[],
	removedTools: readonly string[],
	suppressed: SuppressedMutationTools,
): void {
	for (const name of NATIVE_MUTATION_TOOL_NAMES) {
		if (!removedTools.includes(name) || suppressed.has(name)) continue;
		const index = activeTools.indexOf(name);
		if (index >= 0) suppressed.set(name, index);
	}
}

function restoreSuppressedMutationTools(activeTools: readonly string[], suppressed: SuppressedMutationTools): string[] {
	if (suppressed.size === 0) return [...activeTools];

	const restored = [...activeTools];
	for (const [name, index] of [...suppressed.entries()].sort(([, left], [, right]) => left - right)) {
		if (!restored.includes(name)) restored.splice(Math.min(index, restored.length), 0, name);
	}
	suppressed.clear();
	return restored;
}

function syncActiveTools(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	toolsRegistered: boolean,
	suppressedMutationTools: SuppressedMutationTools,
): void {
	const active = pi.getActiveTools?.() ?? [];
	const settings = loadSettings(ctx.cwd);
	const supportedModelsLoaded = hasConfiguredModelsLoaded(ctx, settings);
	if (!toolsRegistered || !supportedModelsLoaded) {
		const next = restoreSuppressedMutationTools(
			active.filter((name) => !PACKAGE_TOOL_NAMES.includes(name as never)),
			suppressedMutationTools,
		);
		if (next.join("\0") !== active.join("\0")) pi.setActiveTools(next);
		return;
	}
	const next = computeNextActiveTools(active, contextModel(ctx), settings);
	captureSuppressedMutationTools(active, next.removed, suppressedMutationTools);
	const activeTools = next.activeTools.includes("apply_patch")
		? next.activeTools
		: restoreSuppressedMutationTools(next.activeTools, suppressedMutationTools);
	if (activeTools.join("\0") !== active.join("\0")) pi.setActiveTools(activeTools);
}

function statusLines(pi: ExtensionAPI, ctx: ExtensionContext): string[] {
	const settings = loadSettings(ctx.cwd);
	const model = contextModel(ctx);
	const modelSettings = loadModelSettings(model, ctx.cwd, settings);
	const capabilities = computeToolCapabilities(model, settings);
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
		`autoEnable: ${settings.autoEnable}`,
		`provider shim: ${modelSettings.providerShimActive ? "active" : "inactive"}`,
		`responses endpoint: ${modelSettings.apiKeyMode ? "openai" : "codex"}`,
		`responses transport: ${modelSettings.openaiTransport}`,
		`Responses WebSocket prewarm: ${modelSettings.openaiWebSocketPrewarm}`,
		`fast mode: ${settings.fastMode ? modelSettings.fastServiceTier ?? "on (unsupported)" : "off"}${fastModeTier ? ", active" : ""}`,
		`compaction: ${modelSettings.compactionMode}`,
		`request profile: ${requestProfile.responsesMode}/${requestProfile.patchTransport}, system=${requestProfile.systemPromptPlacement}, hosted=${requestProfile.supportsHostedTools}, parallel=${requestProfile.supportsParallelTools}`,
		`web search: ${modelSettings.webSearchImplementation ?? "off"}`,
		`image generation: ${modelSettings.imageGenerationImplementation ?? "off"}`,
		`legacy additionalModelIds: ${settings.additionalModelIds.length > 0 ? settings.additionalModelIds.join(", ") : "(none)"}`,
		`apiKeyMode: ${modelSettings.apiKeyMode}`,
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
		lines.push(`OPENAI_API_KEY: ${process.env.OPENAI_API_KEY ? "present" : "not set"}`);
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

function registerTools(
	pi: ExtensionAPI,
	providerController?: OpenAIResponsesProviderController,
): void {
	pi.registerTool(createImageGenerationToolDefinition({
		loadSettings: (cwd, model) => loadModelSettings(model, cwd),
		getCurrentTurnId: (sessionId) => providerController?.getCurrentTurnId(sessionId),
	}) as never);
	pi.registerTool(createWebSearchToolDefinition({
		getCurrentTurnId: (sessionId) => providerController?.getCurrentTurnId(sessionId),
	}) as never);
	pi.registerTool({
		renderShell: "self",
		name: "view_image",
		label: "View Image",
		description: "Inspect a local image file by returning image content to the model. Relative paths resolve against ctx.cwd; a leading @ is accepted.",
		promptSnippet: "Inspect local image files by path.",
		promptGuidelines: ["Use view_image when you need to inspect a local image file; pass the path in the path argument."],
		parameters: viewImageToolSchema,
		async execute(_toolCallId: string, params: ViewImageInput, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			const settings = loadSettings(ctx.cwd);
			return viewImage(params, ctx.cwd, { workspaceOnly: settings.viewImageWorkspaceOnly }) as never;
		},
		renderCall(args: ViewImageInput, theme: any, context: any) {
			if (context?.executionStarted && !context?.isPartial) return emptyComponent();
			return textComponent(viewImageCallText(args, theme));
		},
		renderResult(result: any, options: any, theme: any, context: any) {
			return viewImageResultComponent(result, options, theme, context);
		},
	} as never);
	pi.registerTool(createApplyPatchToolDefinition({
		deferRendering: loadSettings().deferApplyPatchRendering,
	}) as never);
}

export default function codexMinimalTools(pi: ExtensionAPI): void {
	const guard = pi as unknown as Record<PropertyKey, unknown>;
	if (guard[INSTALL_SYMBOL]) return;
	guard[INSTALL_SYMBOL] = true;

	let currentCwd = process.cwd();
	let toolsRegistered = false;
	let providerController: OpenAIResponsesProviderController | undefined;
	const suppressedMutationTools: SuppressedMutationTools = new Map();
	const ensureToolsRegistered = (ctx: ExtensionContext): boolean => {
		currentCwd = ctx.cwd;
		if (toolsRegistered) return true;
		const settings = loadSettings(ctx.cwd);
		const supportedModelsLoaded = hasConfiguredModelsLoaded(ctx, settings);
		if (!settings.enabled || !supportedModelsLoaded) return false;
		registerTools(pi, providerController);
		toolsRegistered = true;
		return true;
	};

	pi.on("session_start", async (_event, ctx) => {
		syncActiveTools(pi, ctx, ensureToolsRegistered(ctx), suppressedMutationTools);
	});
	pi.on("model_select", async (_event, ctx) => {
		syncActiveTools(pi, ctx, ensureToolsRegistered(ctx), suppressedMutationTools);
	});
	pi.on("thinking_level_select", async (_event, ctx) => {
		syncActiveTools(pi, ctx, ensureToolsRegistered(ctx), suppressedMutationTools);
	});
	pi.on("session_shutdown", async () => {
		const active = pi.getActiveTools?.() ?? [];
		const restored = restoreSuppressedMutationTools(active, suppressedMutationTools);
		if (restored.join("\0") !== active.join("\0")) pi.setActiveTools(restored);
	});

	const initialSettings = loadSettings(currentCwd);
	if (initialSettings.enabled) {
		providerController = registerOpenAIResponsesProviders(pi, { getCurrentCwd: () => currentCwd });
		registerNativeCompaction(pi, providerController);
		registerBackgroundImageGenerationCommand(pi);
	}

	registerDiagnosticCommand(pi);
	registerFastMode(pi);

	pi.on("before_provider_request", (event, ctx) => {
		currentCwd = ctx.cwd;
		const settings = loadSettings(ctx.cwd);
		const model = contextModel(ctx);
		const modelSettings = loadModelSettings(model, ctx.cwd, settings);
		const profile = resolveModelProfile(model, { settings });
		if (
			!settings.enabled
			|| !profile?.effective.enabled
			|| !modelSettings.providerShimActive
			|| !modelSettings.nativeProviderTools
		) return undefined;
		const capabilities = computeToolCapabilities(contextModel(ctx), settings);
		const webSearch = profile.effective.tools.webSearch;
		const result = rewriteNativeOpenAiTools(event.payload, {
			imageModel: settings.imageModel,
			imageGeneration: modelSettings.imageGenerationImplementation ?? false,
			webSearch: capabilities.web_search.enabled
				&& webSearch
				? {
						implementation: webSearch.implementation,
						contentTypes: webSearch.contentTypes,
					}
				: false,
		});
		return result.rewritten.length > 0 ? result.payload : undefined;
	});
}
