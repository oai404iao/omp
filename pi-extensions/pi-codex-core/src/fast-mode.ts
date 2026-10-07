import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	modelKey,
	type ModelLike,
} from "@oai404iao/pi-codex-runtime/internal/capabilities";
import { loadModelSettings } from "@oai404iao/pi-codex-runtime/internal/model-catalog/runtime";
import type { ResolvedCodexModelSettings } from "@oai404iao/pi-codex-runtime/internal/model-catalog/runtime";
import { sessionFastMode, setSessionFastMode } from "@oai404iao/pi-codex-runtime/internal/fast-mode-state";
import {
	configPath,
	loadSettings,
	type CodexMinimalToolsSettings,
} from "@oai404iao/pi-codex-runtime/internal/settings";

export const FAST_MODE_STATUS_KEY = "codex-fast-mode";
export const FAST_MODE_SERVICE_TIER = "priority" as const;

export function isFastModeModel(model: ModelLike | undefined): boolean {
	return Boolean(loadModelSettings(model).fastServiceTier);
}

export function resolveFastModeServiceTier(
	settings: Pick<CodexMinimalToolsSettings, "enabled" | "fastMode"> & Partial<ResolvedCodexModelSettings>,
	model: ModelLike | undefined,
): string | undefined {
	if (!settings.enabled || !settings.fastMode) return undefined;
	if (settings.modelProfile) return settings.fastServiceTier;
	return loadModelSettings(model, undefined, settings as CodexMinimalToolsSettings).fastServiceTier;
}

export function applyFastModeServiceTier<T extends Record<string, unknown>>(
	body: T,
	settings: Pick<CodexMinimalToolsSettings, "enabled" | "fastMode"> & Partial<ResolvedCodexModelSettings>,
	model: ModelLike | undefined,
): T {
	const serviceTier = resolveFastModeServiceTier(settings, model);
	if (!serviceTier || body.service_tier !== undefined) return body;
	return { ...body, service_tier: serviceTier };
}

function fastModeLines(ctx: ExtensionContext): string[] {
	const settings = loadSettings(ctx.cwd);
	const model = ctx.model as ModelLike | undefined;
	const modelSettings = loadModelSettings(model, ctx.cwd, settings, ctx.sessionManager?.getSessionId?.());
	const activeTier = resolveFastModeServiceTier(modelSettings, model);
	return [
		"Codex Fast mode",
		`enabled: ${modelSettings.fastMode}`,
		`config default: ${settings.fastMode}`,
		`service tier: ${modelSettings.fastServiceTier ?? "(unsupported)"}`,
		`model: ${modelKey(model)}`,
		`active for current model: ${Boolean(activeTier)}`,
		`config: ${configPath()}`,
	];
}

export function syncFastModeStatus(ctx: ExtensionContext): void {
	const settings = loadSettings(ctx.cwd);
	const model = ctx.model as ModelLike | undefined;
	const tier = resolveFastModeServiceTier(loadModelSettings(model, ctx.cwd, settings, ctx.sessionManager?.getSessionId?.()), model);
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
		description: "Toggle Fast mode for this session without changing the config default. Usage: /fast [on|off|status]",
		handler: async (args: string, ctx) => {
			const command = args.trim().toLowerCase().split(/\s+/, 1)[0] ?? "";
			const settings = loadSettings(ctx.cwd);
			let enabled: boolean;

			switch (command) {
				case "":
					enabled = !sessionFastMode(ctx.sessionManager.getSessionId(), settings.fastMode);
					break;
				case "on":
					enabled = true;
					break;
				case "off":
					enabled = false;
					break;
				case "status":
					showFastModeStatus(ctx);
					return;
				default:
					ctx.ui.notify("Usage: /fast [on|off|status]", "warning");
					return;
			}

			try {
				setSessionFastMode(pi, ctx.sessionManager, enabled);
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
	pi.on("session_tree", async (_event, ctx) => {
		syncFastModeStatus(ctx);
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		const ui = ctx.ui as ExtensionContext["ui"] | undefined;
		ui?.setStatus?.(FAST_MODE_STATUS_KEY, undefined);
	});
}
