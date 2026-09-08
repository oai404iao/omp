import { dynamicImport } from "../../providers/openai-codex/runtime.js";
import { loadSettings } from "../../settings.js";
import { saveBase64Image } from "../../utils/images.js";
import { type SavedGeneratedImage } from "./types.js";

const OPENAI_CODEX_IMAGE_DIR = ".pi/openai-codex-images";

const OPENAI_CODEX_LATEST_IMAGE_NAME = "latest.png";

let fsPromisesPromise: Promise<typeof import("node:fs/promises")> | undefined;

const workspaceRootCache = new Map<string, Promise<string>>();

const PATH_SEPARATOR = "/";

function sanitizeFilePart(value: string | undefined, fallback: string): string {
	const trimmed = (value ?? "").trim();
	if (!trimmed) return fallback;
	return trimmed.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function shortenFilePart(value: string | undefined, fallback: string): string {
	const safe = sanitizeFilePart(value, fallback);
	const match = /^([a-zA-Z]+_)(.+)$/.exec(safe);
	const prefix = match?.[1] ?? "";
	const body = match?.[2] ?? safe;
	if (body.length <= 12) return `${prefix}${body}`;
	return `${prefix}${body.slice(0, 8)}-${body.slice(-4)}`;
}

export function normalizeImageOutputFormat(value: string | undefined): string {
	const format = (value ?? "png").toLowerCase();
	return format === "png" || format === "jpg" || format === "jpeg" || format === "webp" ? format : "png";
}

function normalizePath(value: string): string {
	if (!value) return ".";
	const normalized = value.replace(/\/+/g, PATH_SEPARATOR);
	if (normalized === PATH_SEPARATOR) return normalized;
	return normalized.replace(/\/+$/g, "") || PATH_SEPARATOR;
}

function joinPaths(...parts: string[]): string {
	if (parts.length === 0) return ".";
	let result = parts[0] ?? "";
	for (let i = 1; i < parts.length; i++) {
		const part = parts[i];
		if (!part) continue;
		if (!result || result.endsWith(PATH_SEPARATOR)) {
			result += part.replace(/^\/+/, "");
		} else {
			result += `${PATH_SEPARATOR}${part.replace(/^\/+/, "")}`;
		}
	}
	return normalizePath(result);
}

function dirnamePath(value: string): string {
	const normalized = normalizePath(value);
	if (normalized === PATH_SEPARATOR) return PATH_SEPARATOR;
	const index = normalized.lastIndexOf(PATH_SEPARATOR);
	if (index < 0) return ".";
	if (index === 0) return PATH_SEPARATOR;
	return normalized.slice(0, index);
}

function splitPathSegments(value: string): string[] {
	const normalized = normalizePath(value);
	if (normalized === PATH_SEPARATOR) return [];
	return normalized.replace(/^\/+/, "").split(PATH_SEPARATOR).filter(Boolean);
}

function relativePath(from: string, to: string): string {
	const normalizedFrom = normalizePath(from);
	const normalizedTo = normalizePath(to);
	if (normalizedFrom === normalizedTo) return "";
	const fromSegments = splitPathSegments(normalizedFrom);
	const toSegments = splitPathSegments(normalizedTo);
	let shared = 0;
	while (shared < fromSegments.length && shared < toSegments.length && fromSegments[shared] === toSegments[shared]) {
		shared++;
	}
	const upSegments = new Array(fromSegments.length - shared).fill("..");
	const downSegments = toSegments.slice(shared);
	return [...upSegments, ...downSegments].join(PATH_SEPARATOR);
}

async function getNodeFsPromises(): Promise<typeof import("node:fs/promises")> {
	if (!fsPromisesPromise) {
		fsPromisesPromise = dynamicImport("node:fs/promises") as Promise<typeof import("node:fs/promises")>;
	}
	return fsPromisesPromise;
}

async function pathExists(value: string): Promise<boolean> {
	try {
		const fs = await getNodeFsPromises();
		await fs.access(value);
		return true;
	} catch {
		return false;
	}
}

async function resolveWorkspaceRoot(cwd: string): Promise<string> {
	const normalizedCwd = normalizePath(cwd);
	const cached = workspaceRootCache.get(normalizedCwd);
	if (cached) return cached;

	const promise = (async () => {
		let current = normalizedCwd;
		while (true) {
			if (await pathExists(joinPaths(current, ".git"))) {
				return current;
			}
			const parent = dirnamePath(current);
			if (parent === current || parent === ".") {
				return normalizedCwd;
			}
			current = parent;
		}
	})();

	workspaceRootCache.set(normalizedCwd, promise);
	return promise;
}

export function getOpenAICodexImageDirectory(cwd: string): string {
	return joinPaths(cwd, OPENAI_CODEX_IMAGE_DIR);
}

export function getOpenAICodexImagePath(cwd: string, responseId: string | undefined, callId: string, outputFormat?: string): string {
	const ext = normalizeImageOutputFormat(outputFormat);
	const safeCallId = shortenFilePart(callId, "image");
	const safeResponseId = shortenFilePart(responseId, "response");
	return joinPaths(getOpenAICodexImageDirectory(cwd), `${safeCallId}-${safeResponseId}.${ext}`);
}

export function getOpenAICodexLatestImagePath(cwd: string): string {
	return joinPaths(getOpenAICodexImageDirectory(cwd), OPENAI_CODEX_LATEST_IMAGE_NAME);
}

export function buildGeneratedImageDisplayText(savedImage: SavedGeneratedImage, options?: { expanded?: boolean }): string {
	const lines: string[] = [];
	if (options?.expanded && savedImage.revisedPrompt) {
		lines.push(`Prompt: ${savedImage.revisedPrompt}`);
	}
	lines.push(`File: ${savedImage.relativePath}`);
	return lines.join("\n");
}

export async function saveOpenAICodexGeneratedImage(
	cwd: string,
	image: { responseId?: string; callId: string; result: string; outputFormat?: string; imageModel?: string; revisedPrompt?: string },
): Promise<SavedGeneratedImage> {
	const workspaceRoot = await resolveWorkspaceRoot(cwd);
	const outputFormat = normalizeImageOutputFormat(image.outputFormat);
	const saved = await saveBase64Image({
		base64: image.result,
		callId: image.callId,
		cwd,
		format: outputFormat,
		responseId: image.responseId,
		settings: loadSettings(cwd),
	});
	const absolutePath = saved.path;
	const latestAbsolutePath = saved.latestPath ?? getOpenAICodexLatestImagePath(workspaceRoot);

	const relativeFilePath = relativePath(workspaceRoot, absolutePath);
	const latestRelativeFilePath = relativePath(workspaceRoot, latestAbsolutePath);
	const relativePathValue = relativeFilePath && !relativeFilePath.startsWith("..") ? relativeFilePath : absolutePath;
	const latestRelativePathValue =
		latestRelativeFilePath && !latestRelativeFilePath.startsWith("..") ? latestRelativeFilePath : latestAbsolutePath;

	return {
		absolutePath,
		relativePath: relativePathValue,
		latestAbsolutePath,
		latestRelativePath: latestRelativePathValue,
		responseId: image.responseId,
		callId: image.callId,
		outputFormat,
		imageModel: image.imageModel,
		revisedPrompt: image.revisedPrompt,
	};
}
