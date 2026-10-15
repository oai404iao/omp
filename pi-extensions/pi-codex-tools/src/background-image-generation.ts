import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { relative } from "node:path";
import { supportsImageInput, type ModelLike } from "@oai404iao/pi-codex-runtime/internal/capabilities";
import { createBackgroundImageJobs, panelBranch } from "./background-image-jobs.js";
import { listResolvedModelProfiles } from "@oai404iao/pi-codex-runtime/internal/model-catalog/catalog";
import { loadModelSettings } from "@oai404iao/pi-codex-runtime/internal/model-catalog/runtime";
import { loadSettings } from "@oai404iao/pi-codex-runtime/internal/settings";
import { standaloneImageGeneration } from "./tools/image-generation.js";
import { buildGeneratedImageDisplayText } from "./tools/image-generation/storage.js";
import { IMAGE_SAVE_DISPLAY_MESSAGE_TYPE, type SavedGeneratedImage } from "./tools/image-generation/types.js";
import { projectRoot } from "./utils/images.js";

const IMAGE_GEN_ERROR_MESSAGE_TYPE = "codex-image-generation-error";

export interface ParsedImageGenCommand {
	prompt: string;
	imagePaths: string[];
}

interface ImageGenerationErrorDetails {
	message: string;
	prompt?: string;
	imageModel?: string;
	referenceCount?: number;
}

interface ModelRegistryLike {
	getAll?: () => unknown;
	getAvailable?: () => unknown;
	find?: (provider: string, id: string) => unknown;
}

function isModelLike(value: unknown): value is ModelLike {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return typeof record.provider === "string" && (typeof record.id === "string" || typeof record.name === "string");
}

function registryModels(registry: ModelRegistryLike | undefined): ModelLike[] {
	if (!registry) return [];
	for (const method of [registry.getAll, registry.getAvailable]) {
		if (typeof method !== "function") continue;
		try {
			const value = method.call(registry);
			if (Array.isArray(value)) return value.filter(isModelLike);
		} catch {
			// Try the next registry shape.
		}
	}
	return [];
}

function isConfiguredImageModel(model: ModelLike | undefined): boolean {
	if (!model || !supportsImageInput(model)) return false;
	const settings = loadModelSettings({ ...model, baseUrl: undefined });
	return Boolean(settings.modelProfile?.effective.enabled && settings.imageGenerationImplementation === "standalone");
}

export function selectCodexImageModel(currentModel: ModelLike | undefined, registry: ModelRegistryLike | undefined): ModelLike | undefined {
	const profile = currentModel && loadModelSettings({ ...currentModel, baseUrl: undefined }).modelProfile;
	if (profile?.removedHostedImageGeneration) {
		throw new Error(`Hosted image generation was removed for ${profile.id}. Change tools.imageGeneration to standalone or false in models.json; no alternate model was selected.`);
	}
	if (isConfiguredImageModel(currentModel)) return currentModel;
	const discovered = registryModels(registry).find(isConfiguredImageModel);
	if (discovered) return discovered;
	for (const profile of listResolvedModelProfiles()) {
		if (!profile.effective.enabled || profile.effective.tools.imageGeneration !== "standalone") continue;
		const slash = profile.id.indexOf("/");
		const candidate = registry?.find?.(profile.id.slice(0, slash), profile.id.slice(slash + 1));
		if (isModelLike(candidate) && isConfiguredImageModel(candidate)) return candidate;
	}
	return undefined;
}

function tokenizeArgs(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let escaped = false;
	for (const ch of input) {
		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = undefined;
			else current += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (/\s/.test(ch)) {
			if (current) tokens.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	if (current) tokens.push(current);
	return tokens;
}

function isSupportedImagePathToken(token: string): boolean {
	const normalized = token.replace(/^file:\/\//, "").replace(/[),.;:]+$/, "");
	if (/^https?:\/\//i.test(normalized) || normalized.startsWith("data:")) return false;
	return /\.(?:png|jpe?g|webp|gif|bmp)$/i.test(normalized);
}

export function parseImageGenCommandArgs(input: string): ParsedImageGenCommand {
	const imagePaths: string[] = [];
	const promptParts: string[] = [];
	for (const token of tokenizeArgs(input.trim())) {
		if (token.startsWith("@") && token.length > 1) imagePaths.push(token.slice(1));
		else if (isSupportedImagePathToken(token)) imagePaths.push(token.replace(/^file:\/\//, "").replace(/[),.;:]+$/, ""));
		else promptParts.push(token);
	}
	return { prompt: promptParts.join(" ").trim(), imagePaths };
}

function renderImageGenError(details: ImageGenerationErrorDetails, theme: Theme): Component {
	return {
		invalidate() {},
		render(width: number): string[] {
			const safeWidth = Math.max(1, width);
			const message = details.message || "Image generation failed.";
			const promptWidth = Math.max(16, safeWidth - 28);
			const lines = [
				`${theme.fg("error", "● ")}${theme.fg("text", theme.bold("Image Generation "))}${theme.fg("error", "failed")}`,
			];
			if (details.imageModel) lines.push(`${panelBranch(theme, "├")}${theme.fg("text", "Model ")}${theme.fg("muted", details.imageModel)}`);
			if (details.referenceCount && details.referenceCount > 0) lines.push(`${panelBranch(theme, "├")}${theme.fg("text", "Refs ")}${theme.fg("muted", `${details.referenceCount}`)}`);
			if (details.prompt) lines.push(`${panelBranch(theme, "├")}${theme.fg("text", "Prompt ")}${theme.fg("muted", truncateToWidth(details.prompt, promptWidth, "…"))}`);
			lines.push(`${panelBranch(theme, "└")}${theme.fg("error", truncateToWidth(message, Math.max(16, safeWidth - 5), "…"))}`);
			return lines.map((line) => truncateToWidth(line, safeWidth, ""));
		},
	};
}

async function runBackgroundImageGeneration(pi: ExtensionAPI, ctx: ExtensionCommandContext, parsed: ParsedImageGenCommand, signal: AbortSignal): Promise<void> {
	signal.throwIfAborted();
	const model = selectCodexImageModel(ctx.model as ModelLike | undefined, ctx.modelRegistry as ModelRegistryLike | undefined) as Model<Api> | undefined;
	if (!model) throw new Error("No image-capable model with an enabled standalone model catalog profile is available.");
	const settings = loadModelSettings({ ...model, baseUrl: undefined }, ctx.cwd);
	const result = await standaloneImageGeneration({
		prompt: parsed.prompt, referenced_image_paths: parsed.imagePaths,
	}, {
		cwd: ctx.cwd, model, modelRegistry: ctx.modelRegistry, sessionManager: ctx.sessionManager,
	}, settings, signal, { callId: "standalone" });
	signal.throwIfAborted();
	const saved = result.details.saved;
	const workspaceRoot = projectRoot(ctx.cwd);
	const relativePath = relative(workspaceRoot, saved.path);
	const latestAbsolutePath = saved.latestPath ?? saved.path;
	const latestRelativePath = relative(workspaceRoot, latestAbsolutePath);
	const savedImage: SavedGeneratedImage = {
		absolutePath: saved.path,
		relativePath: relativePath && !relativePath.startsWith("..") ? relativePath : saved.path,
		latestAbsolutePath,
		latestRelativePath: latestRelativePath && !latestRelativePath.startsWith("..") ? latestRelativePath : latestAbsolutePath,
		responseId: result.details.requestId,
		callId: "standalone", outputFormat: saved.format, imageModel: settings.imageModel,
		revisedPrompt: parsed.prompt,
	};
	pi.sendMessage({
		customType: IMAGE_SAVE_DISPLAY_MESSAGE_TYPE,
		content: [{ type: "text", text: buildGeneratedImageDisplayText(savedImage, { expanded: false }) }],
		display: true, details: { savedImages: [savedImage] },
	}, { triggerTurn: false });
}

export function registerBackgroundImageGenerationCommand(pi: ExtensionAPI): void {
	const jobs = createBackgroundImageJobs();
	pi.on("session_start", (_event, ctx) => jobs.reset(ctx));
	pi.on("session_shutdown", (_event, ctx) => jobs.reset(ctx));
	pi.registerMessageRenderer<ImageGenerationErrorDetails>(IMAGE_GEN_ERROR_MESSAGE_TYPE, (message, _options, theme) => {
		const rawContent = typeof message.content === "string" ? message.content
			: message.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
		return renderImageGenError({
			message: message.details?.message ?? rawContent.replace(/^Image generation failed:\s*/i, "") ?? "Image generation failed.",
			prompt: message.details?.prompt, imageModel: message.details?.imageModel, referenceCount: message.details?.referenceCount,
		}, theme);
	});
	pi.registerCommand("image-gen", {
		description: "Generate or edit an image in the background with the standalone Images API. Usage: /image-gen prompt text [@reference.png]",
		handler: async (args, ctx) => {
			const parsed = parseImageGenCommandArgs(args);
			if (!parsed.prompt) {
				ctx.ui.notify("Usage: /image-gen prompt text [@reference.png]", "warning");
				return;
			}
			const settings = loadSettings(ctx.cwd);
			const job = jobs.start(ctx, parsed, settings.imageModel);
			ctx.ui.notify(`Queued image generation with ${settings.imageModel}${parsed.imagePaths.length ? ` (${parsed.imagePaths.length} reference image${parsed.imagePaths.length === 1 ? "" : "s"})` : ""}.`, "info");
			void runBackgroundImageGeneration(pi, ctx, parsed, job.signal)
				.catch((error) => {
					if (!job.isCurrent()) return;
					const message = error instanceof Error ? error.message : String(error);
					pi.sendMessage({
						customType: IMAGE_GEN_ERROR_MESSAGE_TYPE,
						content: `Image generation failed: ${message}`, display: true,
						details: { message, prompt: parsed.prompt, imageModel: settings.imageModel, referenceCount: parsed.imagePaths.length } satisfies ImageGenerationErrorDetails,
					}, { triggerTurn: false });
				})
				.finally(() => job.finish())
				.catch(() => {}); // Closed UI/API failures must not escape a detached job.
		},
	});
}
