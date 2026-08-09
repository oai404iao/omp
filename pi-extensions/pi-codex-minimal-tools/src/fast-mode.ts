import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	isGpt5SeriesModel,
	isNativeOpenAiProviderModel,
	modelKey,
	type ModelLike,
} from "./capabilities.js";
import {
	configPath,
	loadSettings,
	updateConfig,
	type CodexMinimalToolsSettings,
} from "./settings.js";

export const FAST_MODE_STATUS_KEY = "codex-fast-mode";
export const FAST_MODE_SERVICE_TIER = "priority" as const;

export function isFastModeModel(model: ModelLike | undefined): boolean {
	return isNativeOpenAiProviderModel(model) && isGpt5SeriesModel(model);
}

export function resolveFastModeServiceTier(
	settings: Pick<CodexMinimalToolsSettings, "enabled" | "fastMode">,
	model: ModelLike | undefined,
): typeof FAST_MODE_SERVICE_TIER | undefined {
	return settings.enabled && settings.fastMode && isFastModeModel(model)
		? FAST_MODE_SERVICE_TIER
		: undefined;
}

export function applyFastModeServiceTier<T extends Record<string, unknown>>(
	body: T,
	settings: Pick<CodexMinimalToolsSettings, "enabled" | "fastMode">,
	model: ModelLike | undefined,
): T {
	const serviceTier = resolveFastModeServiceTier(settings, model);
	if (!serviceTier || body.service_tier !== undefined) return body;
	return { ...body, service_tier: serviceTier };
}

function fastModeLines(ctx: ExtensionContext): string[] {
	const settings = loadSettings(ctx.cwd);
	const model = ctx.model as ModelLike | undefined;
	const activeTier = resolveFastModeServiceTier(settings, model);
	return [
		"OpenAI GPT-5 Fast mode",
		`enabled: ${settings.fastMode}`,
		`service tier: ${FAST_MODE_SERVICE_TIER}`,
		`model: ${modelKey(model)}`,
		`active for current model: ${Boolean(activeTier)}`,
		`config: ${configPath()}`,
	];
}

export function syncFastModeStatus(ctx: ExtensionContext): void {
	const settings = loadSettings(ctx.cwd);
	const tier = resolveFastModeServiceTier(settings, ctx.model as ModelLike | undefined);
	const ui = ctx.ui as ExtensionContext["ui"] | undefined;
	ui?.setStatus?.(
		FAST_MODE_STATUS_KEY,
		tier,
	);
}

function showFastModeStatus(ctx: ExtensionCommandContext): void {
	syncFastModeStatus(ctx as ExtensionContext);
	ctx.ui.notify(fastModeLines(ctx as ExtensionContext).join("\n"), "info");
}

export function registerFastMode(pi: ExtensionAPI): void {
	pi.registerCommand("fast", {
		description: "Toggle OpenAI GPT-5 Fast mode. Usage: /fast [on|off|status]",
		handler: async (args: string, ctx) => {
			const command = args.trim().toLowerCase().split(/\s+/, 1)[0] ?? "";
			const settings = loadSettings(ctx.cwd);
			let patch: Partial<CodexMinimalToolsSettings> | undefined;

			switch (command) {
				case "":
					patch = { fastMode: !settings.fastMode };
					break;
				case "on":
					patch = { fastMode: true };
					break;
				case "off":
					patch = { fastMode: false };
					break;
				case "status":
					showFastModeStatus(ctx);
					return;
				default:
					ctx.ui.notify("Usage: /fast [on|off|status]", "warning");
					return;
			}

			try {
				updateConfig(patch);
				showFastModeStatus(ctx);
			} catch (error) {
				ctx.ui.notify(
					`Failed to update Fast mode: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		syncFastModeStatus(ctx);
	});
	pi.on("model_select", async (_event, ctx) => {
		syncFastModeStatus(ctx);
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		const ui = ctx.ui as ExtensionContext["ui"] | undefined;
		ui?.setStatus?.(FAST_MODE_STATUS_KEY, undefined);
	});
}
