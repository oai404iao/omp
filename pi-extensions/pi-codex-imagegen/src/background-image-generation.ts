import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { supportsImageInput, type ModelLike } from "@oai404iao/pi-codex-runtime/internal/capabilities";
import {
	buildCodexJsonHeaders,
	hasCodexRequestAuth,
} from "@oai404iao/pi-codex-runtime/internal/codex-http";
import { createBackgroundImageJobs, panelBranch } from "./background-image-jobs.js";
import { listResolvedModelProfiles } from "@oai404iao/pi-codex-runtime/internal/model-catalog/catalog";
import { loadModelSettings } from "@oai404iao/pi-codex-runtime/internal/model-catalog/runtime";
import { setProviderGeneratedHeader } from "@oai404iao/pi-codex-runtime/internal/provider-headers";
import { loadSettings } from "@oai404iao/pi-codex-runtime/internal/settings";
import { standaloneImageGeneration } from "./tools/image-generation.js";
import {
	buildGeneratedImageDisplayText,
	saveOpenAICodexGeneratedImage,
} from "./tools/image-generation/storage.js";
import { IMAGE_SAVE_DISPLAY_MESSAGE_TYPE, type SavedGeneratedImage } from "./tools/image-generation/types.js";
import { projectRoot } from "./utils/images.js";

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const BACKGROUND_IMAGE_INSTRUCTIONS = "Generate or edit images with the hosted image_generation tool. Use the user's prompt and any provided reference images. Return the image_generation_call result.";
const IMAGE_GEN_ERROR_MESSAGE_TYPE = "codex-image-generation-error";

export interface ParsedImageGenCommand {
	prompt: string;
	imagePaths: string[];
}

interface ReferenceImage {
	path: string;
	mimeType: string;
	base64: string;
}

interface CodexImageResult {
	id: string;
	result: string;
	outputFormat?: string;
	revisedPrompt?: string;
	imageModel?: string;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isModelLike(value: unknown): value is ModelLike {
	return isRecord(value) && typeof value.provider === "string" && (typeof value.id === "string" || typeof value.name === "string");
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
	const settings = loadModelSettings(model);
	return Boolean(
		settings.modelProfile?.effective.enabled
		&& settings.imageGenerationImplementation,
	);
}

export function selectCodexImageModel(currentModel: ModelLike | undefined, registry: ModelRegistryLike | undefined): ModelLike | undefined {
	if (isConfiguredImageModel(currentModel)) return currentModel;
	const discovered = registryModels(registry).find(isConfiguredImageModel);
	if (discovered) return discovered;
	for (const profile of listResolvedModelProfiles()) {
		if (!profile.effective.enabled || !profile.effective.tools.imageGeneration) continue;
		const slash = profile.id.indexOf("/");
		const candidate = registry?.find?.(
			profile.id.slice(0, slash),
			profile.id.slice(slash + 1),
		);
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
	return /\.(?:png|jpe?g|webp)$/i.test(normalized);
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

function mimeTypeForPath(path: string): string {
	const ext = extname(path).toLowerCase();
	if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
	if (ext === ".webp") return "image/webp";
	if (ext === ".png") return "image/png";
	throw new Error(`Unsupported reference image type: ${path}. Use PNG, JPEG, or WebP.`);
}

async function loadReferenceImage(cwd: string, rawPath: string): Promise<ReferenceImage> {
	const path = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
	const buffer = await readFile(path);
	return { path, mimeType: mimeTypeForPath(path), base64: buffer.toString("base64") };
}

function resolveCodexUrl(baseUrl: string | undefined, options?: { apiKeyMode?: boolean }): string {
	const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
	const normalized = raw.replace(/\/+$/, "");
	if (options?.apiKeyMode) {
		if (normalized.endsWith("/responses")) return normalized;
		return `${normalized}/responses`;
	}
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

function buildHeaders(
	model: Model<Api>,
	auth: { apiKey?: string; headers?: ProviderHeaders },
	options?: { apiKeyMode?: boolean },
): Headers {
	const headers = buildCodexJsonHeaders({
		modelHeaders: model.headers,
		auth,
		apiKeyMode: options?.apiKeyMode ?? false,
	});
	setProviderGeneratedHeader(headers, "OpenAI-Beta", "responses=experimental");
	setProviderGeneratedHeader(headers, "accept", "text/event-stream");
	return headers;
}

export function buildBackgroundImageRequest(options: {
	prompt: string;
	referenceImages: ReferenceImage[];
	responsesModel: string;
	imageModel: string;
}): Record<string, unknown> {
	const content: Array<Record<string, unknown>> = [
		{ type: "input_text", text: options.referenceImages.length > 0 ? `Edit the provided image(s): ${options.prompt}` : options.prompt },
		...options.referenceImages.map((image) => ({
			type: "input_image",
			detail: "auto",
			image_url: `data:${image.mimeType};base64,${image.base64}`,
		})),
	];
	return {
		model: options.responsesModel,
		store: false,
		stream: true,
		instructions: BACKGROUND_IMAGE_INSTRUCTIONS,
		input: [{ role: "user", content }],
		tools: [{
			type: "image_generation",
			model: options.imageModel,
			output_format: "png",
			action: options.referenceImages.length > 0 ? "edit" : "generate",
		}],
		tool_choice: { type: "image_generation" },
	};
}

async function* parseSseEvents(response: Response, signal: AbortSignal): AsyncIterable<Record<string, unknown>> {
	if (!response.body) return;
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
	signal.addEventListener("abort", cancel, { once: true });
	if (signal.aborted) cancel();
	try {
		while (true) {
			signal.throwIfAborted();
			const { done, value } = await reader.read();
			signal.throwIfAborted();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let boundary: number;
			while ((boundary = buffer.indexOf("\n\n")) >= 0) {
				const raw = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				for (const line of raw.split(/\r?\n/)) {
					if (!line.startsWith("data:")) continue;
					const data = line.slice(5).trim();
					if (!data || data === "[DONE]") continue;
					yield JSON.parse(data) as Record<string, unknown>;
				}
			}
		}
	} finally {
		signal.removeEventListener("abort", cancel);
		reader.releaseLock();
	}
}

function collectImageResult(results: CodexImageResult[], item: unknown, fallbackImageModel: string): void {
	if (!item || typeof item !== "object") return;
	const candidate = item as Record<string, unknown>;
	if (candidate.type !== "image_generation_call" || typeof candidate.result !== "string") return;
	const id = typeof candidate.id === "string" ? candidate.id : `ig_${results.length}`;
	if (results.some((result) => result.id === id)) return;
	results.push({
		id,
		result: candidate.result,
		outputFormat: typeof candidate.output_format === "string" ? candidate.output_format : "png",
		revisedPrompt: typeof candidate.revised_prompt === "string" ? candidate.revised_prompt : undefined,
		imageModel: typeof candidate.model === "string" ? candidate.model : fallbackImageModel,
	});
}

function collectResponseText(value: unknown, out: string[]): void {
	if (!value || typeof value !== "object") return;
	const item = value as Record<string, unknown>;
	for (const key of ["text", "refusal", "summary_text", "message"] as const) {
		const text = item[key];
		if (typeof text === "string" && text.trim()) out.push(text.trim());
	}
	for (const key of ["content", "output", "summary"] as const) {
		const child = item[key];
		if (Array.isArray(child)) for (const part of child) collectResponseText(part, out);
	}
}

export function summarizeNonImageResponse(response: Record<string, unknown> | undefined): string {
	if (!response) return "No image was returned by Codex.";
	const status = typeof response.status === "string" ? response.status : undefined;
	const error = response.error && typeof response.error === "object" ? response.error as Record<string, unknown> : undefined;
	const errorMessage = typeof error?.message === "string" ? error.message : undefined;
	const texts: string[] = [];
	collectResponseText(response, texts);
	const text = [...new Set(texts)].join(" ").replace(/\s+/g, " ").trim();
	const details = [status && status !== "completed" ? `status ${status}` : undefined, errorMessage, text].filter(Boolean).join(" · ");
	return details ? `No image was returned by Codex: ${details}` : "No image was returned by Codex.";
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
	if (!model) throw new Error("No image-capable model with an enabled model catalog profile is available.");
	const settings = loadModelSettings(model as ModelLike, ctx.cwd);
	if (!settings.enabled) throw new Error("pi-codex-minimal-tools is disabled.");
	if (settings.imageGenerationImplementation === "standalone") {
		const result = await standaloneImageGeneration({
			prompt: parsed.prompt,
			referenced_image_paths: parsed.imagePaths,
		}, {
			cwd: ctx.cwd,
			model,
			modelRegistry: ctx.modelRegistry,
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
			latestRelativePath: latestRelativePath && !latestRelativePath.startsWith("..")
				? latestRelativePath
				: latestAbsolutePath,
			responseId: undefined,
			callId: "standalone",
			outputFormat: saved.format,
			imageModel: settings.imageModel,
			revisedPrompt: parsed.prompt,
		};
		pi.sendMessage({
			customType: IMAGE_SAVE_DISPLAY_MESSAGE_TYPE,
			content: [{ type: "text", text: buildGeneratedImageDisplayText(savedImage, { expanded: false }) }],
			display: true,
			details: { savedImages: [savedImage] },
		}, { triggerTurn: false });
		return;
	}
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	signal.throwIfAborted();
	if (!auth.ok) throw new Error(auth.error);
	if (!hasCodexRequestAuth({
		modelHeaders: model.headers,
		auth: { apiKey: auth.apiKey, headers: auth.headers },
	})) {
		throw new Error(`No request authentication is configured for ${model.provider}.`);
	}
	const referenceImages = await Promise.all(parsed.imagePaths.map((path) => loadReferenceImage(ctx.cwd, path)));
	signal.throwIfAborted();
	const body = buildBackgroundImageRequest({
		prompt: parsed.prompt,
		referenceImages,
		responsesModel: model.id,
		imageModel: settings.imageModel,
	});
	const response = await fetch(resolveCodexUrl(model.baseUrl, { apiKeyMode: settings.apiKeyMode }), {
		signal,
		method: "POST",
		headers: buildHeaders(model, {
			apiKey: auth.apiKey,
			headers: auth.headers,
		}, { apiKeyMode: settings.apiKeyMode }),
		body: JSON.stringify(body),
	});
	signal.throwIfAborted();
	if (!response.ok) throw new Error(`Codex image generation failed: ${response.status} ${await response.text()}`);
	const results: CodexImageResult[] = [];
	let responseId: string | undefined;
	let lastResponse: Record<string, unknown> | undefined;
	for await (const event of parseSseEvents(response, signal)) {
		if (event.type === "response.created" && event.response && typeof event.response === "object") {
			lastResponse = event.response as Record<string, unknown>;
			const id = (event.response as { id?: unknown }).id;
			if (typeof id === "string") responseId = id;
		}
		if (event.type === "response.output_item.done") collectImageResult(results, event.item, settings.imageModel);
		if ((event.type === "response.completed" || event.type === "response.done") && event.response && typeof event.response === "object") {
			lastResponse = event.response as Record<string, unknown>;
			const responseOutput = (event.response as { output?: unknown }).output;
			if (Array.isArray(responseOutput)) for (const item of responseOutput) collectImageResult(results, item, settings.imageModel);
		}
	}
	if (results.length === 0) throw new Error(summarizeNonImageResponse(lastResponse));
	const savedImages = [];
	for (const result of results) {
		signal.throwIfAborted();
		savedImages.push(await saveOpenAICodexGeneratedImage(ctx.cwd, {
			responseId,
			callId: result.id,
			result: result.result,
			outputFormat: result.outputFormat,
			imageModel: result.imageModel,
			revisedPrompt: result.revisedPrompt ?? parsed.prompt,
		}));
	}
	signal.throwIfAborted();
	pi.sendMessage({
		customType: IMAGE_SAVE_DISPLAY_MESSAGE_TYPE,
		content: [{ type: "text", text: buildGeneratedImageDisplayText(savedImages[0], { expanded: false }) }],
		display: true,
		details: { savedImages },
	}, { triggerTurn: false });
}

export function registerBackgroundImageGenerationCommand(pi: ExtensionAPI): void {
	const jobs = createBackgroundImageJobs();
	pi.on("session_start", (_event, ctx) => jobs.reset(ctx));
	pi.on("session_shutdown", (_event, ctx) => jobs.reset(ctx));
	pi.registerMessageRenderer<ImageGenerationErrorDetails>(IMAGE_GEN_ERROR_MESSAGE_TYPE, (message, _options, theme) => {
		const rawContent = typeof message.content === "string"
			? message.content
			: message.content
					.filter((item) => item.type === "text")
					.map((item) => item.text)
					.join("\n");
		const details: ImageGenerationErrorDetails = {
			message: message.details?.message ?? rawContent.replace(/^Image generation failed:\s*/i, "") ?? "Image generation failed.",
			prompt: message.details?.prompt,
			imageModel: message.details?.imageModel,
			referenceCount: message.details?.referenceCount,
		};
		return renderImageGenError(details, theme);
	});

	pi.registerCommand("image-gen", {
		description: "Generate or edit an image in the background with the current model catalog. Usage: /image-gen prompt text [@reference.png]",
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
						content: `Image generation failed: ${message}`,
						display: true,
						details: { message, prompt: parsed.prompt, imageModel: settings.imageModel, referenceCount: parsed.imagePaths.length } satisfies ImageGenerationErrorDetails,
					}, { triggerTurn: false });
				})
				.finally(() => job.finish())
				.catch(() => {}); // Closed UI/API failures must not escape a detached job.
		},
	});
}
