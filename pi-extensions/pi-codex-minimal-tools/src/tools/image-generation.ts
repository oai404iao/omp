import { readFile } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import { buildSessionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { saveBase64Image } from "../utils/images.js";
import type { CodexMinimalToolsSettings } from "../settings.js";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	buildCodexJsonHeaders,
	hasCodexRequestAuth,
	resolveCodexApiEndpoint,
} from "../codex-http.js";
import { loadModelSettings, type ResolvedCodexModelSettings } from "../model-catalog/runtime.js";

export interface ImageGenerationInput {
	prompt?: string;
	referenced_image_paths?: string[];
	num_last_images_to_include?: number;
	size?: "1024x1024" | "1024x1536" | "1536x1024" | "auto";
	quality?: "low" | "medium" | "high" | "auto";
	background?: "transparent" | "opaque" | "auto";
	output_format?: "png" | "webp" | "jpeg";
}

export const imageGenerationToolSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		prompt: { type: "string", description: "Image generation or editing prompt." },
		referenced_image_paths: {
			type: "array",
			maxItems: 5,
			items: { type: "string", minLength: 1 },
			description: "Local PNG, JPEG, or WebP paths to edit.",
		},
		num_last_images_to_include: {
			type: "integer",
			minimum: 1,
			maximum: 5,
			description: "Use the newest conversation images when one or more targets have no local path.",
		},
	},
	required: ["prompt"],
};

async function urlToBase64(url: string, signal?: AbortSignal): Promise<string> {
	const response = await fetch(url, { signal });
	if (!response.ok) throw new Error(`Failed to download generated image: ${response.status} ${await response.text()}`);
	const buffer = Buffer.from(await response.arrayBuffer());
	return buffer.toString("base64");
}

export async function directImageGeneration(input: ImageGenerationInput, cwd: string, settings: CodexMinimalToolsSettings, signal?: AbortSignal) {
	if (!settings.directImageApiFallback) throw new Error("Direct Images API fallback is disabled. Use native openai or openai-codex handling, or enable directImageApiFallback.");
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) throw new Error("OPENAI_API_KEY is required for direct image_generation fallback.");
	if (!input.prompt?.trim()) throw new Error("A prompt is required for direct image_generation fallback.");
	const body: Record<string, unknown> = {
		model: settings.imageModel,
		prompt: input.prompt,
	};
	if (input.size && input.size !== "auto") body.size = input.size;
	if (input.quality && input.quality !== "auto") body.quality = input.quality;
	if (input.background && input.background !== "auto") body.background = input.background;
	if (input.output_format) body.output_format = input.output_format;
	const response = await fetch("https://api.openai.com/v1/images/generations", {
		method: "POST",
		headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
		body: JSON.stringify(body),
		signal,
	});
	if (!response.ok) throw new Error(`OpenAI Images API failed: ${response.status} ${await response.text()}`);
	const json = await response.json() as { data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }> };
	const first = json.data?.[0];
	const base64 = first?.b64_json ?? (first?.url ? await urlToBase64(first.url, signal) : undefined);
	if (!base64) throw new Error("OpenAI Images API returned no image data.");
	const saved = await saveBase64Image({ base64, callId: "direct", cwd, format: input.output_format, responseId: settings.imageModel, settings });
	return {
		content: [{ type: "text", text: `Generated image with ${settings.imageModel}; saved to ${saved.path}${saved.latestPath ? ` (latest: ${saved.latestPath})` : ""}.` }],
		details: { saved, revisedPrompt: first?.revised_prompt, mode: "direct-images-api" },
	};
}

interface ImageGenerationToolContext {
	cwd: string;
	model?: Model<Api>;
	modelRegistry?: {
		getApiKeyAndHeaders(model: Model<Api>): Promise<
			| { ok: true; apiKey?: string; headers?: Record<string, string> }
			| { ok: false; error: string }
		>;
	};
	sessionManager?: {
		getBranch(): SessionEntry[];
	};
}

async function referencedImageUrls(cwd: string, paths: readonly string[]): Promise<Array<{ image_url: string }>> {
	if (paths.length > 5) throw new Error("referenced_image_paths must contain at most 5 paths.");
	return Promise.all(paths.map(async (rawPath) => {
		const normalized = rawPath.replace(/^@/, "");
		const path = isAbsolute(normalized) ? normalized : resolve(cwd, normalized);
		const extension = extname(path).toLowerCase();
		const mimeType = extension === ".png"
			? "image/png"
			: extension === ".jpg" || extension === ".jpeg"
				? "image/jpeg"
				: extension === ".webp"
					? "image/webp"
					: undefined;
		if (!mimeType) throw new Error(`Unsupported reference image type: ${rawPath}. Use PNG, JPEG, or WebP.`);
		const data = await readFile(path);
		return { image_url: `data:${mimeType};base64,${data.toString("base64")}` };
	}));
}

function recentConversationImageUrls(
	ctx: ImageGenerationToolContext,
	count: number,
): Array<{ image_url: string }> {
	if (!ctx.sessionManager) {
		throw new Error("Conversation images are unavailable in this tool context; use referenced_image_paths.");
	}
	const messages = buildSessionContext(ctx.sessionManager.getBranch()).messages;
	const images: string[] = [];
	for (const message of messages) {
		if (message.role === "user" || message.role === "toolResult") {
			if (!Array.isArray(message.content)) continue;
			for (const item of message.content) {
				if (item.type === "image") {
					images.push(`data:${item.mimeType};base64,${item.data}`);
				}
			}
			continue;
		}
		if (message.role !== "assistant") continue;
		for (const block of message.content as unknown[]) {
			if (!block || typeof block !== "object") continue;
			const candidate = block as {
				type?: unknown;
				item?: { result?: unknown };
			};
			if (
				candidate.type === "image_generation_call"
				&& typeof candidate.item?.result === "string"
				&& candidate.item.result
			) {
				images.push(`data:image/png;base64,${candidate.item.result}`);
			}
		}
	}
	if (images.length < count) {
		throw new Error(`Requested the last ${count} conversation images, but only ${images.length} were available.`);
	}
	return images.slice(-count).map((image_url) => ({ image_url }));
}

export async function standaloneImageGeneration(
	input: ImageGenerationInput,
	ctx: ImageGenerationToolContext,
	settings: ResolvedCodexModelSettings,
	signal?: AbortSignal,
	callId = "standalone",
) {
	const model = ctx.model;
	if (!model || !ctx.modelRegistry) throw new Error("No active model is available for standalone image generation.");
	if (!settings.enabled) throw new Error("pi-codex-minimal-tools is disabled.");
	if (!input.prompt?.trim()) throw new Error("A prompt is required for standalone image generation.");
	if (input.num_last_images_to_include !== undefined && input.referenced_image_paths?.length) {
		throw new Error("Provide only one of referenced_image_paths or num_last_images_to_include.");
	}
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(auth.error);
	if (!hasCodexRequestAuth({
		modelHeaders: model.headers,
		auth: { apiKey: auth.apiKey, headers: auth.headers },
	})) {
		throw new Error(`No request authentication for provider: ${model.provider}`);
	}
	const images = input.num_last_images_to_include !== undefined
		? recentConversationImageUrls(ctx, input.num_last_images_to_include)
		: await referencedImageUrls(ctx.cwd, input.referenced_image_paths ?? []);
	const edit = images.length > 0;
	const response = await fetch(
		resolveCodexApiEndpoint(
			model.baseUrl,
			settings.apiKeyMode,
			edit ? "images/edits" : "images/generations",
		),
		{
			method: "POST",
			headers: buildCodexJsonHeaders({
				modelHeaders: model.headers,
				auth: { apiKey: auth.apiKey, headers: auth.headers },
				apiKeyMode: settings.apiKeyMode,
				extraHeaders: {
					"x-codex-image-turn-id": callId,
				},
			}),
			body: JSON.stringify({
				model: settings.imageModel,
				prompt: input.prompt.trim(),
				...(edit ? { images } : {}),
				background: "auto",
				quality: "auto",
				size: "auto",
			}),
			signal,
		},
	);
	if (!response.ok) {
		throw new Error(`Standalone image generation failed: HTTP ${response.status}: ${await response.text()}`);
	}
	const result = await response.json() as {
		data?: Array<{ b64_json?: string }>;
	};
	const base64 = result.data?.[0]?.b64_json;
	if (!base64) throw new Error("Standalone image generation returned no image data.");
	const saved = await saveBase64Image({
		base64,
		callId,
		cwd: ctx.cwd,
		format: "png",
		responseId: settings.imageModel,
		settings,
	});
	return {
		content: [
			{ type: "image", data: base64, mimeType: "image/png" },
			{ type: "text", text: `Generated image with ${settings.imageModel}; saved to ${saved.path}${saved.latestPath ? ` (latest: ${saved.latestPath})` : ""}.` },
		],
		details: { saved, mode: "standalone-images-api" },
	};
}

export function createImageGenerationToolDefinition(options: {
	loadSettings?: (cwd: string, model?: Model<Api>) => CodexMinimalToolsSettings | ResolvedCodexModelSettings;
} = {}) {
	return {
		name: "image_generation",
		label: "Image Generation",
		description: "Generate or edit images using the hosted or standalone implementation selected by the current model profile. Results are saved under imageOutputDir and mirrored to latest.<ext>.",
		promptSnippet: "Generate or edit images with the implementation selected by the current model profile.",
		parameters: imageGenerationToolSchema,
		async execute(toolCallId: string, params: ImageGenerationInput, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ImageGenerationToolContext) {
			const cwd = ctx?.cwd ?? process.cwd();
			const settings = options.loadSettings?.(cwd, ctx.model) ?? loadModelSettings(ctx.model, cwd);
			const resolvedSettings = "modelProfile" in settings
				? settings as ResolvedCodexModelSettings
				: loadModelSettings(ctx.model, cwd, settings);
			if (resolvedSettings.imageGenerationImplementation === "standalone") {
				return standaloneImageGeneration(params, ctx, resolvedSettings, signal, toolCallId);
			}
			if (settings?.directImageApiFallback) return directImageGeneration(params, cwd, settings, signal);
			return {
				content: [{ type: "text", text: "image_generation should be handled by the current model profile. If no hosted or standalone implementation is configured, enable directImageApiFallback with OPENAI_API_KEY." }],
				details: { phase: "native-provider", nativeTool: "image_generation" },
			};
		},
	};
}
