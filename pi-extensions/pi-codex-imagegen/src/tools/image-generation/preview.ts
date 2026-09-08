import { Container, Image, Spacer, Text, getCapabilities, getImageDimensions } from "@earendil-works/pi-tui";
import { glyphs, treeGlyph } from "@oai404iao/pi-codex-runtime/internal/glyphs";
import { themeBold, themeFg } from "@oai404iao/pi-codex-runtime/internal/utils/theme";
import { type CachedImagePreview, type SavedGeneratedImage } from "./types.js";

function getNodeFsSync(): { readFileSync(path: string): Buffer } | null {
	if (typeof process === "undefined" || !(process.versions?.node || process.versions?.bun)) {
		return null;
	}
	const builtinProcess = process as typeof process & { getBuiltinModule?: (specifier: string) => unknown };
	if (typeof builtinProcess.getBuiltinModule !== "function") {
		return null;
	}
	try {
		const module = builtinProcess.getBuiltinModule("node:fs") as { readFileSync?: (path: string) => Buffer } | undefined;
		return typeof module?.readFileSync === "function" ? { readFileSync: module.readFileSync } : null;
	} catch {
		return null;
	}
}

export function makeCachedImagePreview(data: string, mimeType: string, bytes?: number): CachedImagePreview {
	const dimensions = getImageDimensions(data, mimeType) ?? undefined;
	return { data, mimeType, bytes: bytes ?? Buffer.from(data, "base64").byteLength, widthPx: dimensions?.widthPx, heightPx: dimensions?.heightPx };
}

function loadCachedImagePreview(savedImage: SavedGeneratedImage, imagePreviewCache: Map<string, CachedImagePreview>): CachedImagePreview | undefined {
	const cached = imagePreviewCache.get(savedImage.absolutePath);
	if (cached) return cached;
	const fs = getNodeFsSync();
	if (!fs) return undefined;
	try {
		const buffer = fs.readFileSync(savedImage.absolutePath);
		const data = buffer.toString("base64");
		const mimeType = `image/${savedImage.outputFormat}`;
		const preview = makeCachedImagePreview(data, mimeType, buffer.byteLength);
		imagePreviewCache.set(savedImage.absolutePath, preview);
		return preview;
	} catch {
		return undefined;
	}
}

function formatImageBytes(bytes: number | undefined): string | undefined {
	if (!Number.isFinite(bytes) || !bytes) return undefined;
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10}K`;
	return `${Math.round(bytes / (1024 * 102.4)) / 10}M`;
}

function shouldRenderInlineImage(): { ok: boolean; reason?: string } {
	if (process.env.TMUX) return { ok: false, reason: "inline preview disabled in tmux to avoid overlay/stale image artifacts" };
	const protocol = getCapabilities().images;
	if (!protocol) return { ok: false, reason: "terminal image protocol unavailable" };
	return { ok: true };
}

export function renderImageGenerationMessage(savedImage: SavedGeneratedImage | undefined, messageContent: unknown, options: any, theme: any, imagePreviewCache: Map<string, CachedImagePreview>): Container {
	const container = new Container();
	const preview = savedImage ? loadCachedImagePreview(savedImage, imagePreviewCache) : undefined;
	const type = savedImage?.outputFormat?.toUpperCase() ?? preview?.mimeType?.replace(/^image\//, "").toUpperCase() ?? "IMAGE";
	const dimensions = preview?.widthPx && preview?.heightPx ? `${preview.widthPx}x${preview.heightPx}` : undefined;
	const size = formatImageBytes(preview?.bytes);
	const imageModel = savedImage?.imageModel ? `model ${savedImage.imageModel}` : undefined;
	const meta = [imageModel, type, dimensions, size].filter(Boolean).join(glyphs().dot);
	const label = `${themeFg(theme, "accent", glyphs().bullet)}${themeFg(theme, "text", themeBold(theme, "Image Generation "))}`;
	const pathText = savedImage?.relativePath ?? (typeof messageContent === "string" ? messageContent : "generated image");
	const lines = [`${label}${themeFg(theme, "accent", pathText)}${meta ? themeFg(theme, "dim", `${glyphs().dot}${meta}`) : ""}`];
	if (savedImage?.latestRelativePath) lines.push(`${themeFg(theme, "muted", `  ${treeGlyph("├")}`)}${themeFg(theme, "text", "Latest ")}${themeFg(theme, "accent", savedImage.latestRelativePath)}`);
	if (options?.expanded && savedImage?.revisedPrompt) lines.push(`${themeFg(theme, "muted", `  ${treeGlyph("├")}`)}${themeFg(theme, "text", "Prompt ")}${themeFg(theme, "dim", savedImage.revisedPrompt)}`);
	const inline = shouldRenderInlineImage();
	if (!inline.ok) lines.push(`${themeFg(theme, "muted", `  ${treeGlyph("└")}`)}${themeFg(theme, "warning", inline.reason ?? "inline preview unavailable")}`);
	container.addChild(new Text(lines.join("\n"), 0, 0));
	if (savedImage && preview && inline.ok) {
		container.addChild(new Spacer(1));
		container.addChild(new Image(preview.data, preview.mimeType, { fallbackColor: (text) => themeFg(theme, "dim", text) }, { maxWidthCells: 72, maxHeightCells: options?.expanded ? 24 : 14, filename: savedImage.relativePath }));
	}
	return container;
}
