import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { buildSessionContext, detectSupportedImageMimeTypeFromFile, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { saveBase64Image } from "../utils/images.js";
import { imageGenerationOutput, imageGenerationOutputSchema } from "./image-generation/output.js";
import type { CodexMinimalToolsSettings } from "@oai404iao/pi-codex-runtime/internal/settings";
import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import { buildCodexJsonHeaders, hasCodexRequestAuth, resolveCodexApiEndpoint, withResolvedAuthBaseUrl } from "@oai404iao/pi-codex-runtime/internal/codex-http";
import { loadModelSettings, type ResolvedCodexModelSettings } from "@oai404iao/pi-codex-runtime/internal/model-catalog/runtime";
import { checkEndpointResponse, rememberResolvedEndpoint, requireEndpointCapability } from "@oai404iao/pi-codex-runtime/internal/endpoint-state";
import { currentCodexTurn, uuidV7 } from "@oai404iao/pi-codex-runtime/internal/codex-wire-identity";
import { fetchCodexJson } from "@oai404iao/pi-codex-runtime/internal/json-request";

export interface ImageGenerationInput {
	prompt?: string;
	referenced_image_paths?: string[] | null;
	num_last_images_to_include?: number | null;
	transparent_background?: boolean;
}

export const imageGenerationToolSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		prompt: { type: "string", description: "Image generation or editing prompt." },
		referenced_image_paths: {
			type: ["array", "null"], maxItems: 5,
			items: { type: "string", minLength: 1 },
			description: "Local image paths to edit. PNG, JPEG, WebP, GIF and BMP are supported.",
		},
		num_last_images_to_include: {
			type: ["integer", "null"], minimum: 1, maximum: 5,
			description: "Use the newest conversation images when one or more targets have no local path.",
		},
		transparent_background: {
			type: "boolean",
			description: "Whether the output should have a transparent background. Defaults to false.",
		},
	},
	required: ["prompt"],
};

interface ImageGenerationToolContext {
	cwd: string;
	model?: Model<Api>;
	modelRegistry?: {
		getApiKeyAndHeaders(model: Model<Api>): Promise<
			| { ok: true; apiKey?: string; headers?: ProviderHeaders; baseUrl?: string }
			| { ok: false; error: string }
		>;
	};
	sessionManager?: {
		getSessionId?(): string;
		getBranch(): SessionEntry[];
	};
}

export interface StandaloneImageGenerationInvocation {
	callId?: string;
	turnId?: string;
}

async function referencedImageUrls(cwd: string, paths: readonly string[]): Promise<Array<{ image_url: string }>> {
	if (paths.length > 5) throw new Error("referenced_image_paths must contain at most 5 paths.");
	return Promise.all(paths.map(async (rawPath) => {
		const normalized = rawPath.replace(/^@/, "");
		const path = isAbsolute(normalized) ? normalized : resolve(cwd, normalized);
		const mimeType = await detectSupportedImageMimeTypeFromFile(path);
		if (!mimeType) throw new Error(`Unsupported reference image type: ${rawPath}. Use PNG, JPEG, WebP, GIF, or BMP.`);
		const data = await readFile(path);
		if (mimeType === "image/gif" || mimeType === "image/bmp") {
			// Codex Original mode normalizes unsupported source formats to PNG without resizing.
			const { PhotonImage } = await import("@silvia-odwyer/photon-node");
			const decoded = PhotonImage.new_from_byteslice(data);
			try {
				return { image_url: `data:image/png;base64,${Buffer.from(decoded.get_bytes()).toString("base64")}` };
			} finally {
				decoded.free();
			}
		}
		return { image_url: `data:${mimeType};base64,${data.toString("base64")}` };
	}));
}

function recentConversationImageUrls(ctx: ImageGenerationToolContext, count: number): Array<{ image_url: string }> {
	if (!ctx.sessionManager) throw new Error("Conversation images are unavailable in this tool context; use referenced_image_paths.");
	if (!Number.isSafeInteger(count) || count < 1 || count > 5) {
		throw new Error("num_last_images_to_include must be an integer between 1 and 5.");
	}
	const messages = buildSessionContext(ctx.sessionManager.getBranch()).messages;
	const images: string[] = [];
	for (const message of messages) {
		if (message.role === "user" || message.role === "toolResult") {
			if (!Array.isArray(message.content)) continue;
			for (const item of message.content) {
				if (item.type === "image") images.push(`data:${item.mimeType};base64,${item.data}`);
			}
			continue;
		}
		if (message.role !== "assistant") continue;
		for (const block of message.content as unknown[]) {
			if (!block || typeof block !== "object") continue;
			const candidate = block as { type?: unknown; item?: { result?: unknown } };
			if (candidate.type === "image_generation_call" && typeof candidate.item?.result === "string" && candidate.item.result) {
				images.push(`data:image/png;base64,${candidate.item.result}`);
			}
		}
	}
	if (images.length < count) throw new Error(`Requested the last ${count} conversation images, but only ${images.length} were available.`);
	return images.slice(-count).map((image_url) => ({ image_url }));
}

export async function standaloneImageGeneration(
	input: ImageGenerationInput,
	ctx: ImageGenerationToolContext,
	settings: ResolvedCodexModelSettings,
	signal?: AbortSignal,
	invocation: StandaloneImageGenerationInvocation = {},
) {
	signal?.throwIfAborted();
	const callId = invocation.callId ?? "standalone";
	const sessionId = ctx.sessionManager?.getSessionId?.();
	const turnId = invocation.turnId ?? currentCodexTurn(sessionId)?.turnId ?? uuidV7();
	const model = ctx.model;
	if (!model || !ctx.modelRegistry) throw new Error("No active model is available for standalone image generation.");
	if (!settings.enabled) throw new Error("pi-codex-minimal-tools is disabled.");
	if (!settings.imageGeneration) throw new Error("Image generation is disabled by the global setting or current model profile.");
	if (settings.imageGenerationImplementation !== "standalone") throw new Error("Image generation requires a standalone model profile.");
	if (!input.prompt?.trim()) throw new Error("A prompt is required for standalone image generation.");
	if (input.transparent_background !== undefined && typeof input.transparent_background !== "boolean") {
		throw new Error("transparent_background must be a boolean.");
	}
	if (input.num_last_images_to_include != null && input.referenced_image_paths?.length) {
		throw new Error("Provide only one of referenced_image_paths or num_last_images_to_include.");
	}
	// Capture the invocation's images and turn before auth can yield to another turn.
	const images = input.num_last_images_to_include != null
		? recentConversationImageUrls(ctx, input.num_last_images_to_include)
		: await referencedImageUrls(ctx.cwd, input.referenced_image_paths ?? []);
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	signal?.throwIfAborted();
	if (!auth.ok) throw new Error(auth.error);
	const requestModel = withResolvedAuthBaseUrl(model, auth);
	rememberResolvedEndpoint(model, requestModel, sessionId);
	requireEndpointCapability(settings.endpoint_config, requestModel, sessionId, "imageGeneration.standalone");
	if (!hasCodexRequestAuth({ modelHeaders: model.headers, auth })) {
		throw new Error(`No request authentication for provider: ${model.provider}`);
	}
	const response = await fetchCodexJson(
		resolveCodexApiEndpoint(auth.baseUrl ?? model.baseUrl, settings.responsesEndpoint, images.length ? "images/edits" : "images/generations"),
		{
			headers: buildCodexJsonHeaders({
				codexRequestExtensions: settings.codexRequestExtensions,
				modelHeaders: model.headers, auth, endpoint: settings.responsesEndpoint,
				extraHeaders: settings.codexRequestExtensions ? { "x-codex-image-turn-id": turnId } : undefined,
			}),
			body: JSON.stringify({
				model: settings.imageModel, prompt: input.prompt,
				...(images.length ? { images } : {}),
				background: input.transparent_background === true ? "transparent" : "opaque",
				quality: "auto", size: "auto",
			}),
			signal,
		},
		["imageGeneration.standalone"],
	);
	signal?.throwIfAborted();
	await checkEndpointResponse(response, requestModel, sessionId, ["imageGeneration.standalone"], signal);
	const result = await response.json() as { data?: Array<{ b64_json?: string; generation_id?: string }> };
	signal?.throwIfAborted();
	const base64 = result.data?.[0]?.b64_json;
	if (!base64) throw new Error("Standalone image generation returned no image data.");
	const saved = await saveBase64Image({ base64, callId, cwd: ctx.cwd, format: "png", responseId: settings.imageModel, settings });
	signal?.throwIfAborted();
	return {
		content: [
			{ type: "image", data: base64, mimeType: "image/png" },
			{ type: "text", text: `Generated image with ${settings.imageModel}; saved to ${saved.path}${saved.latestPath ? ` (latest: ${saved.latestPath})` : ""}.` },
		],
		details: {
			saved, mode: "standalone-images-api",
			requestId: response.headers.get("x-codex-imagegen-request-id") ?? undefined,
			generationId: result.data?.[0]?.generation_id,
		},
		structuredContent: imageGenerationOutput(saved, base64),
	};
}

export function createImageGenerationToolDefinition(options: {
	loadSettings?: (cwd: string, model?: Model<Api>) => CodexMinimalToolsSettings | ResolvedCodexModelSettings;
	getCurrentTurnId?: (sessionId: string | undefined) => string | undefined;
} = {}) {
	return {
		name: "image_generation",
		label: "Image Generation",
		description: "Generate or edit images using the standalone Images API selected by the current model profile. Results are saved under imageOutputDir and mirrored to latest.png.",
		promptSnippet: "Generate or edit images with the implementation selected by the current model profile.",
		parameters: imageGenerationToolSchema,
		outputSchema: imageGenerationOutputSchema,
		async execute(toolCallId: string, params: ImageGenerationInput, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ImageGenerationToolContext) {
			const cwd = ctx?.cwd ?? process.cwd();
			const profileModel = ctx.model ? { ...ctx.model, baseUrl: "" } : undefined;
			const settings = options.loadSettings?.(cwd, profileModel) ?? loadModelSettings(profileModel, cwd);
			const resolved = "modelProfile" in settings ? settings as ResolvedCodexModelSettings : loadModelSettings(profileModel, cwd, settings);
			return standaloneImageGeneration(params, { ...ctx, cwd }, resolved, signal, {
				callId: toolCallId, turnId: options.getCurrentTurnId?.(ctx.sessionManager?.getSessionId?.()),
			});
		},
	};
}
