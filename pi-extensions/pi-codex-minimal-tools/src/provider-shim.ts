import {
	buildSessionContext,
	convertToLlm,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { glyphs, treeGlyph } from "./glyphs.js";
import { loadSettings } from "./settings.js";
import { loadModelSettings, type ResolvedCodexModelSettings } from "./model-catalog/runtime.js";
import { resolveCodexRequestProfile, type CodexRequestProfile } from "./codex-request-profile.js";
import { saveBase64Image } from "./utils/images.js";
import { Container, getCapabilities, getImageDimensions, Image, Spacer, Text } from "@earendil-works/pi-tui";
import {
	createAssistantMessageEventStream,
	appendAssistantMessageDiagnostic,
	clampThinkingLevel,
	createAssistantMessageDiagnostic,
	getEnvApiKey,
	streamSimpleOpenAICodexResponses,
	streamSimpleOpenAIResponses,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
	type ThinkingLevel,
} from "@earendil-works/pi-ai";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { ProxyAgent } from "undici";
import type { Dispatcher } from "undici";
import {
	collectHistoricalCitationSources,
	collectWebSearchCitationSources,
	convertResponsesMessages,
	convertResponsesTools,
	encodeWebSearchActivityTextSignature,
	processResponsesStream,
	type CitationSource,
	type WebSearchCitationSource,
} from "./providers/openai-responses-shared.js";
import { createCodexApplyPatchCustomTool } from "./providers/codex-apply-patch-tool.js";
import { createCodexReservedNamespaceTool } from "./codex-reserved-tools.js";
import { rewriteNativeOpenAiTools } from "./provider-native-tools.js";
import { applyFastModeServiceTier } from "./fast-mode.js";
import {
	hasCodexRequestAuth,
	resolveCodexRequestAccountId,
} from "./codex-http.js";

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
export const IMAGE_SAVE_DISPLAY_MESSAGE_TYPE = "codex-image-generation-display";
export const WEB_SEARCH_ACTIVITY_MESSAGE_TYPE = "codex-web-search-activity";
const OPENAI_CODEX_IMAGE_DIR = ".pi/openai-codex-images";
const OPENAI_CODEX_LATEST_IMAGE_NAME = "latest.png";
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const SSE_RESPONSE_HEADER_TIMEOUT_MS = 20_000;
const WEBSOCKET_CONNECT_TIMEOUT_MS = 15_000;
const WEBSOCKET_IDLE_TIMEOUT_MS = 300_000;
const WEBSOCKET_SEND_TIMEOUT_MS = 300_000;
const WEBSOCKET_EVENT_QUEUE_CAPACITY = 1600;
const DEFAULT_WEBSOCKET_STREAM_MAX_RETRIES = 5;
const MAX_WEBSOCKET_STREAM_MAX_RETRIES = 100;
const WEBSOCKET_RETRY_BASE_DELAY_MS = 200;
const WEBSOCKET_RETRY_MAX_DELAY_MS = 60_000;
const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
const WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE = "websocket_connection_limit_reached";
const PREVIOUS_RESPONSE_NOT_FOUND_CODE = "previous_response_not_found";
const CODEX_RESPONSE_STATUSES = new Set(["completed", "incomplete", "failed", "cancelled", "queued", "in_progress"]);
const OPENAI_BETA_RESPONSES_WEBSOCKETS = "responses_websockets=2026-02-06";
const X_OPENAI_INTERNAL_CODEX_RESPONSES_LITE = "x-openai-internal-codex-responses-lite";
const WS_RESPONSES_LITE_CLIENT_METADATA_KEY = "ws_request_header_x_openai_internal_codex_responses_lite";
const WS_STREAM_REQUEST_START_MS_CLIENT_METADATA_KEY = "x-codex-ws-stream-request-start-ms";
const WEB_SEARCH_SOURCES_INCLUDE = "web_search_call.action.sources";
const WEB_SEARCH_RESULTS_INCLUDE = "web_search_call.results";
const SESSION_WEBSOCKET_CACHE_TTL_MS = 5 * 60 * 1000;
const CODEX_COMPACTION_TRIGGER_TYPE = "compaction_trigger";
const CODEX_RETAINED_MESSAGE_TOKEN_BUDGET = 64_000;
const CODEX_MAX_RETAINED_AGENT_MESSAGE_TOKENS = 10_000;
const CODEX_REMOTE_COMPACTION_STREAM_RETRIES = 2;
const X_CODEX_BETA_FEATURES = "x-codex-beta-features";
const CODEX_REMOTE_COMPACTION_V2_FEATURE = "remote_compaction_v2";
const APPROX_BYTES_PER_TOKEN = 4;
const dynamicImport = (specifier: string) => import(specifier);
let _os: { platform(): string; release(): string; arch(): string } | null = null;

if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
	dynamicImport("node:os")
		.then((module) => {
			_os = module;
		})
		.catch(() => {
			_os = null;
		});
}

export interface SavedGeneratedImage {
	absolutePath: string;
	relativePath: string;
	latestAbsolutePath: string;
	latestRelativePath: string;
	responseId: string | undefined;
	callId: string;
	outputFormat: string;
	imageModel?: string;
	revisedPrompt?: string;
}

interface ImageDisplayMessageDetails {
	savedImages: SavedGeneratedImage[];
}

interface PendingImageDisplay {
	savedImage: SavedGeneratedImage;
	imageData: { data: string; mimeType: string };
}

interface QueuedImageActivity extends PendingImageDisplay {
	kind: "image";
}

export interface SurfacedWebSearch {
	callId: string;
	status?: string;
	completed?: boolean;
	actionType?: string;
	query?: string;
	queries: string[];
	url?: string;
	pattern?: string;
	sources: Array<{ title?: string; url: string }>;
	responseItem?: Record<string, unknown>;
}

type PendingActivity = QueuedImageActivity;

interface CachedImagePreview {
	data: string;
	mimeType: string;
	bytes: number;
	widthPx?: number;
	heightPx?: number;
}

interface WebSocketLike {
	readyState?: number;
	bufferedAmount?: number;
	send(data: string, callback?: (error?: Error) => void): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: string, listener: (event: unknown) => void): void;
	removeEventListener(type: string, listener: (event: unknown) => void): void;
}

interface SessionWebSocketCacheEntry {
	socket: WebSocketLike;
	busy: boolean;
	waiters: WebSocketAcquireWaiter[];
	idleTimer?: ReturnType<typeof setTimeout>;
	continuation?: CachedWebSocketContinuationState;
}

interface WebSocketAcquireWaiter {
	resolve: (acquired: AcquiredWebSocket) => void;
	reject: (error: Error) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
}

interface AcquiredWebSocket {
	socket: WebSocketLike;
	entry?: SessionWebSocketCacheEntry;
	reused: boolean;
	release: (options?: { keep?: boolean }) => void;
}

interface CachedWebSocketContinuationState {
	lastRequestBody: ResponsesBody;
	lastResponseId: string;
	lastResponseItems: unknown[];
}

interface WebSocketPrewarmRequest {
	url: string;
	headers: Headers;
	cacheKey: string;
	body: ResponsesBody;
	requestMetadata: WebSocketRequestMetadata;
	signal?: AbortSignal;
	connectTimeoutMs?: number;
}

interface WebSocketRequestMetadata {
	sessionId?: string;
	threadId?: string;
	turnId: string;
}

export interface OpenAIResponsesProviderController {
	getCurrentTurnId(sessionId: string | undefined): string | undefined;
}

let fsPromisesPromise: Promise<typeof import("node:fs/promises")> | undefined;
const workspaceRootCache = new Map<string, Promise<string>>();

const PATH_SEPARATOR = "/";

interface ResponsesBody {
	model: string;
	store: boolean;
	stream: boolean;
	instructions?: string;
	previous_response_id?: string;
	input: unknown[];
	text: { verbosity: string };
	include: string[];
	prompt_cache_key?: string;
	tool_choice: "auto";
	parallel_tool_calls: boolean;
	temperature?: number;
	service_tier?: string;
	generate?: boolean;
	tools?: unknown[];
	reasoning?: {
		effort?: string;
		summary?: string;
		context?: "all_turns";
	};
	client_metadata?: Record<string, string>;
	[key: string]: unknown;
}

interface ResponseEnvelope {
	id?: string;
	status?: string;
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		total_tokens?: number;
		input_tokens_details?: { cached_tokens?: number };
	};
	service_tier?: string;
	error?: { message?: string };
	[key: string]: unknown;
}

type ServiceTier = ResponseCreateParamsStreaming["service_tier"];
type ProviderTransport = NonNullable<SimpleStreamOptions["transport"]>;

const websocketSessionCache = new Map<string, SessionWebSocketCacheEntry>();
const websocketConnectionPromises = new Map<string, Promise<SessionWebSocketCacheEntry>>();
const websocketHttpFallbackSessions = new Set<string>();

class NonRetryableProviderError extends Error {}
class ProviderResponseError extends Error {
	code?: string;
	errorType?: string;
	status?: number;
	retryAfterMs?: number;
}
class ProviderProtocolError extends Error {}
class WebSocketHandshakeError extends Error {
	constructor(
		public readonly status: number,
		message: string,
		public readonly headers: Record<string, string> = {},
		public readonly body?: string,
	) {
		super(withHttpStatusPrefix(status, message));
		this.name = "WebSocketHandshakeError";
	}
}

interface NodeWebSocketModule {
	WebSocket: new (url: string, options?: Record<string, unknown>) => {
		readyState: number;
		bufferedAmount: number;
		send(data: string, callback?: (error?: Error) => void): void;
		close(code?: number, reason?: string): void;
		terminate?(): void;
		on(type: string, listener: (...args: any[]) => void): void;
		off(type: string, listener: (...args: any[]) => void): void;
	};
}

let nodeWebSocketModulePromise: Promise<NodeWebSocketModule> | undefined;

const HTTP_STATUS_MESSAGE_PREFIX = /^HTTP\s+\d{3}(?::|\b)/i;

interface StreamEventShape {
	type?: string;
	status?: number;
	status_code?: number;
	sequence_number?: number;
	error?: {
		type?: string;
		message?: string;
		code?: string;
		plan_type?: string;
		resets_at?: number;
		[key: string]: unknown;
	};
	response?: ResponseEnvelope;
	item_id?: string;
	output_index?: number;
	item?: {
		id?: string;
		type?: string;
		result?: string | null;
		output_format?: string;
		revised_prompt?: string;
		status?: string;
		[key: string]: unknown;
	};
	code?: string;
	message?: string;
	[key: string]: unknown;
}

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

function normalizeImageOutputFormat(value: string | undefined): string {
	const format = (value ?? "png").toLowerCase();
	return format === "png" || format === "jpg" || format === "jpeg" || format === "webp" ? format : "png";
}

function shortHash(str: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < str.length; i++) {
		const ch = str.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
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

export function resolveCodexUrl(baseUrl: string | undefined, options?: { apiKeyMode?: boolean }): string {
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

export function resolveResponsesWebSocketUrl(baseUrl: string | undefined, options?: { apiKeyMode?: boolean }): string {
	const url = new URL(resolveCodexUrl(baseUrl, options));
	if (url.protocol === "https:") url.protocol = "wss:";
	if (url.protocol === "http:") url.protocol = "ws:";
	return url.toString();
}

function headersToRecord(headers: Headers): Record<string, string> {
	return Object.fromEntries(headers.entries());
}

function createCodexRequestId(): string {
	if (typeof globalThis.crypto?.randomUUID === "function") {
		return globalThis.crypto.randomUUID();
	}
	return `codex_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function createPiTurnId(): string {
	if (typeof globalThis.crypto?.randomUUID === "function") {
		return globalThis.crypto.randomUUID();
	}
	return `turn_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function buildBaseCodexHeaders(
	modelHeaders: Record<string, string> | undefined,
	additionalHeaders: Record<string, string> | undefined,
	accountId: string | undefined,
	token: string,
): Headers {
	const headers = new Headers(modelHeaders);
	const explicitAuthorization = Object.entries(additionalHeaders ?? {}).some(
		([key, value]) => key.toLowerCase() === "authorization" && value.trim().length > 0,
	);
	for (const [key, value] of Object.entries(additionalHeaders ?? {})) {
		headers.set(key, value);
	}

	if (!explicitAuthorization && token) headers.set("Authorization", `Bearer ${token}`);
	if (accountId && !headers.has("chatgpt-account-id")) headers.set("chatgpt-account-id", accountId);
	if (!headers.has("originator")) headers.set("originator", "pi");
	if (!headers.has("User-Agent")) {
		headers.set("User-Agent", _os ? `pi (${_os.platform()} ${_os.release()}; ${_os.arch()})` : "pi (browser)");
	}
	return headers;
}

function buildSSEHeaders(
	modelHeaders: Record<string, string> | undefined,
	additionalHeaders: Record<string, string> | undefined,
	accountId: string | undefined,
	token: string,
	sessionId: string | undefined,
	profile: CodexRequestProfile,
): Headers {
	const headers = buildBaseCodexHeaders(modelHeaders, additionalHeaders, accountId, token);
	headers.set("OpenAI-Beta", "responses=experimental");
	headers.set("accept", "text/event-stream");
	headers.set("content-type", "application/json");
	if (profile.responsesMode === "lite") headers.set(X_OPENAI_INTERNAL_CODEX_RESPONSES_LITE, "true");

	if (sessionId) {
		headers.set("session_id", sessionId);
		headers.set("x-client-request-id", sessionId);
	}

	return headers;
}

function appendCommaSeparatedHeader(headers: Headers, name: string, value: string): void {
	const values = (headers.get(name) ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	if (!values.includes(value)) headers.set(name, [...values, value].join(","));
}

function applyConfiguredResponsesFeatureHeaders(
	headers: Headers,
	settings: ResolvedCodexModelSettings,
	_model: Model<Api>,
): Headers {
	if (settings.compactionMode === "responses") {
		appendCommaSeparatedHeader(
			headers,
			X_CODEX_BETA_FEATURES,
			CODEX_REMOTE_COMPACTION_V2_FEATURE,
		);
	}
	return headers;
}

export function buildWebSocketHeaders(
	modelHeaders: Record<string, string> | undefined,
	additionalHeaders: Record<string, string> | undefined,
	accountId: string | undefined,
	token: string,
	sessionId: string,
	threadId = sessionId,
): Headers {
	const headers = buildBaseCodexHeaders(modelHeaders, additionalHeaders, accountId, token);
	headers.delete("accept");
	headers.delete("content-type");
	headers.delete("OpenAI-Beta");
	headers.delete("openai-beta");
	headers.set("OpenAI-Beta", OPENAI_BETA_RESPONSES_WEBSOCKETS);
	headers.set("x-client-request-id", threadId);
	headers.set("session-id", sessionId);
	headers.set("thread-id", threadId);
	return headers;
}

function clampReasoningEffort(modelId: string, effort: string): string {
	const id = modelId.includes("/") ? (modelId.split("/").pop() ?? modelId) : modelId;
	const gpt5MinorMatch = /^gpt-5\.(\d+)/.exec(id);
	const gpt5Minor = gpt5MinorMatch ? Number.parseInt(gpt5MinorMatch[1], 10) : undefined;
	if (gpt5Minor !== undefined && gpt5Minor >= 2 && effort === "minimal") return "low";
	if (id === "gpt-5.1" && effort === "xhigh") return "high";
	if (id === "gpt-5.1-codex-mini") return effort === "high" || effort === "xhigh" ? "high" : "medium";
	return effort;
}

function thinkingLevelFromUnknown(value: unknown): ThinkingLevel | undefined {
	return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh"
		? value
		: undefined;
}

function getServiceTierCostMultiplier(
	model: Model<Api>,
	serviceTier: ServiceTier,
	cwd: string,
): number {
	if (serviceTier === "flex") return 0.5;
	const settings = loadModelSettings(model, cwd);
	return serviceTier && serviceTier === settings.fastServiceTier
		? settings.fastCostMultiplier ?? 1
		: 1;
}

function applyServiceTierPricing(
	usage: AssistantMessage["usage"],
	serviceTier: ServiceTier,
	model: Model<Api>,
	cwd: string,
): void {
	const multiplier = getServiceTierCostMultiplier(model, serviceTier, cwd);
	if (multiplier === 1) return;
	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

function resolveCodexServiceTier(responseServiceTier: ServiceTier, requestServiceTier: ServiceTier): ServiceTier {
	if (
		responseServiceTier === "default"
		&& (requestServiceTier === "flex" || requestServiceTier === "priority")
	) {
		return requestServiceTier;
	}
	return responseServiceTier ?? requestServiceTier;
}

function withRequestServiceTier(
	options: SimpleStreamOptions | undefined,
	serviceTier: unknown,
): SimpleStreamOptions | undefined {
	if (
		serviceTier !== "auto"
		&& serviceTier !== "default"
		&& serviceTier !== "flex"
		&& serviceTier !== "scale"
		&& serviceTier !== "priority"
	) {
		return options;
	}
	return { ...options, serviceTier } as SimpleStreamOptions;
}

function hasNativeWebSearchTool(body: ResponsesBody): boolean {
	return Array.isArray(body.tools) && body.tools.some((tool) => Boolean(tool) && typeof tool === "object" && (tool as { type?: unknown }).type === "web_search");
}

function ensureWebSearchDetailsIncluded(body: ResponsesBody): void {
	if (!hasNativeWebSearchTool(body)) return;
	const include = Array.isArray(body.include) ? body.include : [];
	const missing = [WEB_SEARCH_SOURCES_INCLUDE, WEB_SEARCH_RESULTS_INCLUDE].filter((value) => !include.includes(value));
	if (missing.length > 0) body.include = [...include, ...missing];
}

function stripResponsesLiteImageDetails(value: unknown): void {
	if (Array.isArray(value)) {
		for (const item of value) stripResponsesLiteImageDetails(item);
		return;
	}
	if (!value || typeof value !== "object") return;
	const record = value as Record<string, unknown>;
	if (record.type === "input_image") delete record.detail;
	for (const entry of Object.values(record)) stripResponsesLiteImageDetails(entry);
}

export function withResponsesLiteWebSocketMetadata<T extends { client_metadata?: Record<string, string> }>(body: T, responsesMode: CodexRequestProfile["responsesMode"]): T {
	if (responsesMode !== "lite") return body;
	return {
		...body,
		client_metadata: {
			...body.client_metadata,
			[WS_RESPONSES_LITE_CLIENT_METADATA_KEY]: "true",
		},
	};
}

function withWebSocketRequestMetadata(body: ResponsesBody, metadata: WebSocketRequestMetadata): ResponsesBody {
	return {
		...body,
		client_metadata: {
			...body.client_metadata,
			...(metadata.sessionId ? { session_id: metadata.sessionId } : {}),
			...(metadata.threadId ? { thread_id: metadata.threadId } : {}),
			turn_id: metadata.turnId,
			[WS_STREAM_REQUEST_START_MS_CLIENT_METADATA_KEY]: Date.now().toString(),
		},
	};
}

export function buildRequestBody<TApi extends Api>(model: Model<TApi>, context: Context, profile: CodexRequestProfile, options?: SimpleStreamOptions): ResponsesBody {
	const messages = convertResponsesMessages(model, context, new Set([...CODEX_TOOL_CALL_PROVIDERS, model.provider]), {
		includeSystemPrompt: false,
	});
	const tools = context.tools && context.tools.length > 0
		? convertResponsesTools(context.tools, { strict: null }).map((tool) =>
			profile.patchTransport === "custom" && tool.type === "function" && tool.name === "apply_patch" ? createCodexApplyPatchCustomTool() : tool)
		: [];
	const lite = profile.responsesMode === "lite";
	const liteTools = (): unknown[] => {
		const namespaces = new Map<string, {
			type: "namespace";
			name: string;
			description: string;
			tools: unknown[];
		}>();
		for (const tool of tools as Array<Record<string, unknown>>) {
			if (typeof tool.name !== "string") continue;
			if (tool.name === "web_search" || tool.name === "image_generation") {
				const reserved = createCodexReservedNamespaceTool(tool.name);
				namespaces.set(reserved.name, reserved);
				continue;
			}
			let namespace = namespaces.get("functions");
			if (!namespace) {
				namespace = {
					type: "namespace",
					name: "functions",
					description: "",
					tools: [],
				};
				namespaces.set("functions", namespace);
			}
			const nestedTool: Record<string, unknown> = { ...tool };
			if (nestedTool.type === "function" && typeof nestedTool.strict !== "boolean") {
				nestedTool.strict = false;
			}
			namespace.tools.push(nestedTool);
		}
		return [...namespaces.values()].filter((namespace) => namespace.tools.length > 0);
	};

	const body: ResponsesBody = {
		model: model.id,
		store: false,
		stream: true,
		input: [],
		text: { verbosity: ((options as { textVerbosity?: string } | undefined)?.textVerbosity ?? "low") as string },
		include: ["reasoning.encrypted_content"],
		prompt_cache_key: options?.sessionId,
		tool_choice: "auto",
		parallel_tool_calls: profile.supportsParallelTools,
	};
	if (lite) {
		stripResponsesLiteImageDetails(messages);
		body.input = [
			{ type: "additional_tools", role: "developer", tools: liteTools() },
			...(context.systemPrompt
				? [{ type: "message", role: "developer", content: [{ type: "input_text", text: context.systemPrompt }] }]
				: []),
			...messages,
		];
		body.reasoning = { context: "all_turns" };
	} else {
		if (profile.systemPromptPlacement === "instructions") {
			body.instructions = context.systemPrompt;
			body.input = messages;
		} else {
			body.input = [
				...(context.systemPrompt
					? [{ type: "message", role: "developer", content: [{ type: "input_text", text: context.systemPrompt }] }]
					: []),
				...messages,
			];
		}
		if (tools.length > 0) body.tools = tools;
	}

	// The Codex ChatGPT-backed endpoint rejects output-token cap fields with
	// `Unsupported parameter: max_output_tokens`. Pi's branch summarizer passes
	// `maxTokens`, so forwarding it breaks `/tree` summaries and extensions that
	// use `ctx.navigateTree(..., { summarize: true })`.

	if ((options as { temperature?: number } | undefined)?.temperature !== undefined) {
		body.temperature = (options as { temperature?: number }).temperature;
	}

	const serviceTier = (options as { serviceTier?: string } | undefined)?.serviceTier;
	if (serviceTier !== undefined) {
		body.service_tier = serviceTier;
	}

	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;
	if (reasoningEffort !== undefined) {
		const effort = model.thinkingLevelMap?.[reasoningEffort] ?? reasoningEffort;
		if (effort === null) return body;
		const reasoning = body.reasoning ?? {};
		reasoning.effort = clampReasoningEffort(model.id, effort);
		const summary = (options as { reasoningSummary?: string } | undefined)?.reasoningSummary ?? (lite ? undefined : "auto");
		if (summary && summary !== "none") reasoning.summary = summary;
		body.reasoning = reasoning;
	}

	return body;
}

function isRetryableError(status: number, errorText: string): boolean {
	if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
		return true;
	}
	return /rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused/i.test(errorText);
}

export function withHttpStatusPrefix(status: number, message: string): string {
	const trimmed = message.trim() || "Request failed";
	if (HTTP_STATUS_MESSAGE_PREFIX.test(trimmed)) return trimmed;
	return `HTTP ${status}: ${trimmed}`;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Request was aborted"));
			return;
		}

		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(new Error("Request was aborted"));
			},
			{ once: true },
		);
	});
}

export function responseHeaderTimeoutMsFromOptions(options: SimpleStreamOptions | undefined): number {
	const value = (options as { timeoutMs?: unknown } | undefined)?.timeoutMs;
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : SSE_RESPONSE_HEADER_TIMEOUT_MS;
}

export async function fetchWithResponseHeaderTimeout(
	url: string,
	init: RequestInit,
	parentSignal: AbortSignal | undefined,
	timeoutMs = SSE_RESPONSE_HEADER_TIMEOUT_MS,
): Promise<Response> {
	if (parentSignal?.aborted) throw new Error("Request was aborted");

	const controller = new AbortController();
	let timedOut = false;
	let parentAborted = false;
	const timeoutMessage = `Codex Responses SSE response headers timed out after ${timeoutMs}ms`;

	const onParentAbort = () => {
		parentAborted = true;
		controller.abort(parentSignal?.reason);
	};

	if (parentSignal) parentSignal.addEventListener("abort", onParentAbort, { once: true });
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort(new Error(timeoutMessage));
	}, Math.max(1, timeoutMs));

	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} catch (error) {
		if (timedOut) throw new Error(timeoutMessage);
		if (parentAborted || parentSignal?.aborted) throw new Error("Request was aborted");
		throw error;
	} finally {
		clearTimeout(timeout);
		if (parentSignal) parentSignal.removeEventListener("abort", onParentAbort);
	}
}

async function* parseSSE(response: Response): AsyncIterable<StreamEventShape> {
	if (!response.body) return;

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
			let idx = buffer.indexOf("\n\n");
			while (idx !== -1) {
				const chunk = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 2);
				const dataLines = chunk
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trim());
				if (dataLines.length > 0) {
					const data = dataLines.join("\n").trim();
					if (data && data !== "[DONE]") {
						try {
							yield JSON.parse(data) as StreamEventShape;
						} catch {
							// Ignore malformed SSE chunks and continue consuming the stream.
						}
					}
				}
				idx = buffer.indexOf("\n\n");
			}
		}
	} finally {
		try {
			await reader.cancel();
		} catch {
			// ignore cancellation errors
		}
		try {
			reader.releaseLock();
		} catch {
			// ignore lock release errors
		}
	}
}

function envFirst(names: string[]): string | undefined {
	if (typeof process === "undefined") return undefined;
	for (const name of names) {
		const value = process.env[name];
		if (value?.trim()) return value.trim();
	}
	return undefined;
}

function noProxyMatches(hostname: string, noProxy: string | undefined): boolean {
	if (!noProxy) return false;
	const host = hostname.toLowerCase();
	for (const rawPart of noProxy.split(",")) {
		const part = rawPart.trim().toLowerCase();
		if (!part) continue;
		if (part === "*") return true;
		const normalized = part.startsWith(".") ? part.slice(1) : part;
		if (host === normalized || host.endsWith(`.${normalized}`)) return true;
	}
	return false;
}

export function proxyForWebSocketUrl(rawUrl: string): string | undefined {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return undefined;
	}
	const noProxy = envFirst(["NO_PROXY", "no_proxy"]);
	if (noProxyMatches(url.hostname, noProxy)) return undefined;
	if (url.protocol === "wss:" || url.protocol === "https:") {
		return envFirst(["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]);
	}
	if (url.protocol === "ws:" || url.protocol === "http:") {
		return envFirst(["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]);
	}
	return undefined;
}

async function proxyDispatcherForUrl(rawUrl: string): Promise<Dispatcher | undefined> {
	const proxy = proxyForWebSocketUrl(rawUrl);
	if (!proxy) return undefined;
	return new ProxyAgent(proxy);
}

export async function webSocketOptionsForUrl(url: string, headers: Record<string, string>): Promise<{
	headers: Record<string, string>;
	dispatcher?: Dispatcher;
}> {
	const dispatcher = await proxyDispatcherForUrl(url);
	return dispatcher ? { headers, dispatcher } : { headers };
}

function getWebSocketReadyState(socket: WebSocketLike): number | undefined {
	return typeof socket.readyState === "number" ? socket.readyState : undefined;
}

function isWebSocketReusable(socket: WebSocketLike): boolean {
	const readyState = getWebSocketReadyState(socket);
	return readyState === undefined || readyState === 1;
}

function closeWebSocketSilently(socket: WebSocketLike, code = 1000, reason = "done"): void {
	try {
		socket.close(code, reason);
	} catch {
		// ignore close errors
	}
}

export function closeProviderWebSocketSessions(sessionId?: string): void {
	for (const cacheKey of websocketConnectionPromises.keys()) {
		if (sessionId && !cacheKey.startsWith(`${sessionId}\n`)) continue;
		websocketConnectionPromises.delete(cacheKey);
	}
	for (const [cacheKey, entry] of websocketSessionCache) {
		if (sessionId && !cacheKey.startsWith(`${sessionId}\n`)) continue;
		if (entry.idleTimer) clearTimeout(entry.idleTimer);
		for (const waiter of entry.waiters.splice(0)) {
			if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
			waiter.reject(new Error("WebSocket session closed"));
		}
		closeWebSocketSilently(entry.socket, 1000, "session_shutdown");
		websocketSessionCache.delete(cacheKey);
	}
	if (sessionId) {
		for (const fallbackKey of websocketHttpFallbackSessions) {
			if (fallbackKey.startsWith(`${sessionId}\n`)) websocketHttpFallbackSessions.delete(fallbackKey);
		}
	} else {
		websocketHttpFallbackSessions.clear();
	}
}


function scheduleSessionWebSocketExpiry(cacheKey: string, entry: SessionWebSocketCacheEntry): void {
	if (entry.idleTimer) {
		clearTimeout(entry.idleTimer);
	}
	entry.idleTimer = setTimeout(() => {
		if (entry.busy || entry.waiters.length > 0) return;
		closeWebSocketSilently(entry.socket, 1000, "idle_timeout");
		websocketSessionCache.delete(cacheKey);
	}, SESSION_WEBSOCKET_CACHE_TTL_MS);
}

function removeWebSocketWaiter(entry: SessionWebSocketCacheEntry, waiter: WebSocketAcquireWaiter): void {
	const index = entry.waiters.indexOf(waiter);
	if (index >= 0) entry.waiters.splice(index, 1);
	if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
}

function acquireCachedWebSocketEntry(
	cacheKey: string,
	entry: SessionWebSocketCacheEntry,
	reused: boolean,
): AcquiredWebSocket {
	entry.busy = true;
	let released = false;
	const release = ({ keep } = {} as { keep?: boolean }) => {
		if (released) return;
		const reusable = keep !== false && isWebSocketReusable(entry.socket);
		if (!reusable) {
			released = true;
			if (entry.idleTimer) clearTimeout(entry.idleTimer);
			closeWebSocketSilently(entry.socket);
			if (websocketSessionCache.get(cacheKey) === entry) {
				websocketSessionCache.delete(cacheKey);
			}
			for (const waiter of entry.waiters.splice(0)) {
				if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
				waiter.reject(new Error("WebSocket connection became unavailable"));
			}
			return;
		}

		while (entry.waiters.length > 0) {
			const waiter = entry.waiters.shift()!;
			if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
			if (waiter.signal?.aborted) {
				waiter.reject(new Error("Request was aborted"));
				continue;
			}
			released = true;
			waiter.resolve(acquireCachedWebSocketEntry(cacheKey, entry, true));
			return;
		}

		entry.busy = false;
		released = true;
		scheduleSessionWebSocketExpiry(cacheKey, entry);
	};
	return {
		socket: entry.socket,
		entry,
		reused,
		release,
	};
}

async function waitForCachedWebSocket(
	cacheKey: string,
	entry: SessionWebSocketCacheEntry,
	signal: AbortSignal | undefined,
): Promise<AcquiredWebSocket> {
	if (signal?.aborted) throw new Error("Request was aborted");
	return new Promise<AcquiredWebSocket>((resolve, reject) => {
		const waiter: WebSocketAcquireWaiter = {
			resolve,
			reject,
			...(signal ? { signal } : {}),
		};
		if (signal) {
			waiter.onAbort = () => {
				removeWebSocketWaiter(entry, waiter);
				reject(new Error("Request was aborted"));
			};
			signal.addEventListener("abort", waiter.onAbort, { once: true });
		}
		entry.waiters.push(waiter);
	});
}

function extractWebSocketError(event: unknown): Error {
	if (event && typeof event === "object") {
		const message = "message" in event ? (event as { message?: unknown }).message : undefined;
		if (typeof message === "string" && message.length > 0) {
			return new Error(message);
		}
		const nestedError = "error" in event ? (event as { error?: unknown }).error : undefined;
		if (nestedError instanceof Error && nestedError.message.length > 0) {
			return nestedError;
		}
		if (nestedError && typeof nestedError === "object" && "message" in nestedError) {
			const nestedMessage = (nestedError as { message?: unknown }).message;
			if (typeof nestedMessage === "string" && nestedMessage.length > 0) {
				return new Error(nestedMessage);
			}
		}
	}
	return new Error("WebSocket error");
}

function extractWebSocketCloseError(event: unknown): Error {
	if (event && typeof event === "object") {
		const code = "code" in event ? (event as { code?: unknown }).code : undefined;
		const reason = "reason" in event ? (event as { reason?: unknown }).reason : undefined;
		const codeText = typeof code === "number" ? ` ${code}` : "";
		const reasonText = typeof reason === "string" && reason.length > 0 ? ` ${reason}` : "";
		return new Error(`WebSocket closed${codeText}${reasonText}`.trim());
	}
	return new Error("WebSocket closed");
}

async function loadNodeWebSocketModule(): Promise<NodeWebSocketModule> {
	if (!nodeWebSocketModulePromise) {
		nodeWebSocketModulePromise = dynamicImport("ws") as Promise<NodeWebSocketModule>;
	}
	return nodeWebSocketModulePromise;
}

function nodeWebSocketHeaders(headers: Headers): Record<string, string> {
	return Object.fromEntries(headers.entries());
}

function nodeWebSocketResponseHeaders(headers: unknown): Record<string, string> {
	if (!headers || typeof headers !== "object") return {};
	const result: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
		if (Array.isArray(value)) result[name] = value.join(", ");
		else if (typeof value === "string") result[name] = value;
		else if (value !== undefined) result[name] = String(value);
	}
	return result;
}

function handshakeMessage(status: number, statusText: string | undefined, body: string): string {
	const trimmedBody = body.trim();
	if (trimmedBody) {
		try {
			const parsed = JSON.parse(trimmedBody) as { error?: { message?: unknown }; message?: unknown };
			const message = typeof parsed.error?.message === "string"
				? parsed.error.message
				: typeof parsed.message === "string"
					? parsed.message
					: undefined;
			if (message?.trim()) return message.trim();
		} catch {
			return trimmedBody;
		}
	}
	return statusText?.trim() || "WebSocket upgrade failed";
}

async function connectWebSocket(
	url: string,
	headers: Headers,
	signal: AbortSignal | undefined,
	timeoutMs = WEBSOCKET_CONNECT_TIMEOUT_MS,
): Promise<WebSocketLike> {
	if (signal?.aborted) throw new Error("Request was aborted");
	const { WebSocket } = await loadNodeWebSocketModule();
	const proxy = proxyForWebSocketUrl(url);
	let agent: unknown;
	if (proxy) {
		const protocol = new URL(proxy).protocol.toLowerCase();
		if (protocol === "http:" || protocol === "https:") {
			const { HttpsProxyAgent } = await dynamicImport("https-proxy-agent") as typeof import("https-proxy-agent");
			agent = new HttpsProxyAgent(proxy);
		} else if (protocol === "socks:" || protocol === "socks4:" || protocol === "socks4a:" || protocol === "socks5:" || protocol === "socks5h:") {
			const { SocksProxyAgent } = await dynamicImport("socks-proxy-agent") as {
				SocksProxyAgent: new (proxy: string) => unknown;
			};
			agent = new SocksProxyAgent(proxy);
		} else {
			throw new Error(`Unsupported WebSocket proxy protocol: ${protocol}`);
		}
	}

	return new Promise((resolve, reject) => {
		let settled = false;
		let socket: InstanceType<NodeWebSocketModule["WebSocket"]>;
		let timeout: ReturnType<typeof setTimeout> | undefined;

		try {
			socket = new WebSocket(url, {
				headers: nodeWebSocketHeaders(headers),
				perMessageDeflate: true,
				...(agent ? { agent } : {}),
			});
		} catch (error) {
			reject(error instanceof Error ? error : new Error(String(error)));
			return;
		}

		const onOpen = () => {
			if (settled) return;
			settled = true;
			cleanup();
			// Keep an error listener installed while the socket sits idle in the
			// session cache. Request parsers add their own listener, but Node's ws
			// EventEmitter would otherwise treat an idle "error" as uncaught.
			socket.on("error", () => {});
			const messageListeners = new Map<(event: unknown) => void, (...args: any[]) => void>();
			const closeListeners = new Map<(event: unknown) => void, (...args: any[]) => void>();
			resolve({
				get readyState() {
					return socket.readyState;
				},
				get bufferedAmount() {
					return socket.bufferedAmount;
				},
				send(data, callback) {
					socket.send(data, callback);
				},
				close(code, reason) {
					socket.close(code, reason);
				},
				addEventListener(type, listener) {
					if (type === "message") {
						const wrapped = (data: unknown, isBinary: boolean) => listener({ data, isBinary });
						messageListeners.set(listener, wrapped);
						socket.on("message", wrapped);
						return;
					}
					if (type === "close") {
						const wrapped = (code: number, reason: Buffer) => listener({
							code,
							reason: reason.toString("utf8"),
						});
						closeListeners.set(listener, wrapped);
						socket.on("close", wrapped);
						return;
					}
					socket.on(type, listener as (...args: any[]) => void);
				},
				removeEventListener(type, listener) {
					if (type === "message") {
						const wrapped = messageListeners.get(listener);
						if (wrapped) socket.off("message", wrapped);
						messageListeners.delete(listener);
						return;
					}
					if (type === "close") {
						const wrapped = closeListeners.get(listener);
						if (wrapped) socket.off("close", wrapped);
						closeListeners.delete(listener);
						return;
					}
					socket.off(type, listener as (...args: any[]) => void);
				},
			});
		};
		const onError = (event: unknown) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(event instanceof Error ? event : extractWebSocketError(event));
		};
		const onClose = (code: number, reason: Buffer) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(extractWebSocketCloseError({ code, reason: reason.toString("utf8") }));
		};
		const onUnexpectedResponse = (
			_request: unknown,
			response: { statusCode?: number; statusMessage?: string; headers?: unknown; on(type: string, listener: (...args: any[]) => void): void },
		) => {
			if (settled) return;
			let body = "";
			response.on("data", (chunk: unknown) => {
				if (body.length >= 64 * 1024) return;
				body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
			});
			response.on("end", () => {
				if (settled) return;
				settled = true;
				cleanup();
				const status = response.statusCode ?? 500;
				reject(new WebSocketHandshakeError(
					status,
					handshakeMessage(status, response.statusMessage, body),
					nodeWebSocketResponseHeaders(response.headers),
					body || undefined,
				));
			});
		};
		const onAbort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			socket.on("error", () => {});
			socket.terminate?.();
			reject(new Error("Request was aborted"));
		};
		const onTimeout = () => {
			if (settled) return;
			settled = true;
			cleanup();
			socket.on("error", () => {});
			socket.terminate?.();
			reject(new Error(`OpenAI Responses WebSocket connection timed out after ${timeoutMs}ms`));
		};

		const cleanup = () => {
			if (timeout) clearTimeout(timeout);
			socket.off("open", onOpen);
			socket.off("error", onError);
			socket.off("close", onClose);
			socket.off("unexpected-response", onUnexpectedResponse);
			signal?.removeEventListener("abort", onAbort);
		};

		socket.on("open", onOpen);
		socket.on("error", onError);
		socket.on("close", onClose);
		socket.on("unexpected-response", onUnexpectedResponse);
		signal?.addEventListener("abort", onAbort, { once: true });
		timeout = setTimeout(onTimeout, Math.max(1, timeoutMs));
	});
}

async function acquireWebSocket(
	url: string,
	headers: Headers,
	cacheKey: string | undefined,
	sessionId: string | undefined,
	signal: AbortSignal | undefined,
	connectTimeoutMs: number,
): Promise<AcquiredWebSocket> {
	if (!cacheKey || !sessionId) {
		const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs);
		return {
			socket,
			reused: false,
			release: ({ keep } = {}) => {
				if (keep === false) {
					closeWebSocketSilently(socket);
					return;
				}
				closeWebSocketSilently(socket);
			},
		};
	}

	const cached = websocketSessionCache.get(cacheKey);
	if (cached) {
		if (cached.idleTimer) {
			clearTimeout(cached.idleTimer);
			cached.idleTimer = undefined;
		}

		if (!cached.busy && isWebSocketReusable(cached.socket)) {
			return acquireCachedWebSocketEntry(cacheKey, cached, true);
		}

		if (cached.busy) {
			return waitForCachedWebSocket(cacheKey, cached, signal);
		}

		if (!isWebSocketReusable(cached.socket)) {
			closeWebSocketSilently(cached.socket);
			websocketSessionCache.delete(cacheKey);
		}
	}

	let pendingConnection = websocketConnectionPromises.get(cacheKey);
	if (!pendingConnection) {
		let connectionPromise!: Promise<SessionWebSocketCacheEntry>;
		connectionPromise = connectWebSocket(url, headers, signal, connectTimeoutMs)
			.then((socket) => {
				if (websocketConnectionPromises.get(cacheKey) !== connectionPromise) {
					closeWebSocketSilently(socket, 1000, "session_shutdown");
					throw new Error("WebSocket session closed");
				}
				const entry: SessionWebSocketCacheEntry = { socket, busy: false, waiters: [] };
				websocketSessionCache.set(cacheKey, entry);
				return entry;
			})
			.finally(() => {
				if (websocketConnectionPromises.get(cacheKey) === connectionPromise) {
					websocketConnectionPromises.delete(cacheKey);
				}
			});
		websocketConnectionPromises.set(cacheKey, connectionPromise);
		pendingConnection = connectionPromise;
	}
	const entry = await pendingConnection;
	if (entry.busy) return waitForCachedWebSocket(cacheKey, entry, signal);
	return acquireCachedWebSocketEntry(cacheKey, entry, false);
}

function requestBodyWithoutInput(body: ResponsesBody): ResponsesBody {
	const {
		input: _input,
		previous_response_id: _previousResponseId,
		client_metadata: _clientMetadata,
		stream_options: _streamOptions,
		generate: _generate,
		...rest
	} = body;
	return rest as ResponsesBody;
}

function normalizeResponseItemForComparison(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalizeResponseItemForComparison);
	if (!value || typeof value !== "object") return value;
	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (key === "internal_chat_message_metadata_passthrough") continue;
		result[key] = normalizeResponseItemForComparison(entry);
	}
	return result;
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "undefined";
}

function responseInputsEqual(a: unknown[] | undefined, b: unknown[] | undefined): boolean {
	const left = a ?? [];
	const right = b ?? [];
	if (left.length !== right.length) return false;
	return left.every((item, index) =>
		stableJson(normalizeResponseItemForComparison(item))
		=== stableJson(normalizeResponseItemForComparison(right[index])));
}

function requestBodiesMatchExceptInput(a: ResponsesBody, b: ResponsesBody): boolean {
	return stableJson(requestBodyWithoutInput(a)) === stableJson(requestBodyWithoutInput(b));
}

function getCachedWebSocketInputDelta(body: ResponsesBody, continuation: CachedWebSocketContinuationState): unknown[] | undefined {
	if (!requestBodiesMatchExceptInput(body, continuation.lastRequestBody)) {
		return undefined;
	}

	const currentInput = body.input ?? [];
	const baseline = [...(continuation.lastRequestBody.input ?? []), ...continuation.lastResponseItems];
	if (currentInput.length < baseline.length) {
		return undefined;
	}

	const prefix = currentInput.slice(0, baseline.length);
	if (!responseInputsEqual(prefix, baseline)) {
		return undefined;
	}

	return currentInput.slice(baseline.length);
}

function buildCachedWebSocketRequestBody(
	entry: SessionWebSocketCacheEntry,
	body: ResponsesBody,
): ResponsesBody {
	const continuation = entry.continuation;
	if (!continuation) {
		return body;
	}

	const delta = getCachedWebSocketInputDelta(body, continuation);
	if (delta === undefined || !continuation.lastResponseId) {
		entry.continuation = undefined;
		return body;
	}
	return {
		...body,
		previous_response_id: continuation.lastResponseId,
		input: delta,
	};
}

function isPrefixedResponseItemId(value: string): boolean {
	const separator = value.indexOf("_");
	return separator > 0 && separator < value.length - 1;
}

function prepareResponseItemsForWire(items: unknown[]): unknown[] {
	return items.map((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return item;
		const record = item as Record<string, unknown>;
		if (typeof record.id !== "string" || isPrefixedResponseItemId(record.id)) return item;
		const { id: _id, ...rest } = record;
		return rest;
	});
}

function prepareWebSocketRequestBodyForWire(body: ResponsesBody): ResponsesBody {
	return {
		...body,
		input: prepareResponseItemsForWire(body.input ?? []),
	};
}

export async function sendWebSocketRequest(
	socket: WebSocketLike,
	payload: string,
	signal: AbortSignal | undefined,
	timeoutMs = WEBSOCKET_SEND_TIMEOUT_MS,
): Promise<void> {
	if (signal?.aborted) throw new Error("Request was aborted");
	await new Promise<void>((resolve, reject) => {
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			if (error) reject(error);
			else resolve();
		};
		const onAbort = () => finish(new Error("Request was aborted"));
		timeout = setTimeout(
			() => finish(new Error(`OpenAI Responses WebSocket send timed out after ${timeoutMs}ms`)),
			Math.max(1, timeoutMs),
		);
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			socket.send(payload, (error?: Error) => {
				if (error) {
					finish(new Error(`Failed to send OpenAI Responses WebSocket request: ${error.message}`));
					return;
				}
				finish();
			});
		} catch (error) {
			finish(error instanceof Error ? error : new Error(String(error)));
		}
	});
}

async function* parseWebSocket(socket: WebSocketLike, signal: AbortSignal | undefined): AsyncIterable<StreamEventShape> {
	const queue: StreamEventShape[] = [];
	let pending: (() => void) | null = null;
	let done = false;
	let failed: Error | null = null;
	let closeError: Error | null = null;
	let sawCompletion = false;
	let pendingMessages = 0;
	let messageChain = Promise.resolve();

	const wake = () => {
		if (!pending) return;
		const resolve = pending;
		pending = null;
		resolve();
	};

	const onMessage = (event: unknown) => {
		if (done) return;
		if (queue.length + pendingMessages >= WEBSOCKET_EVENT_QUEUE_CAPACITY) {
			failed = new ProviderProtocolError(
				`OpenAI Responses WebSocket event queue exceeded ${WEBSOCKET_EVENT_QUEUE_CAPACITY} items`,
			);
			done = true;
			wake();
			return;
		}
		pendingMessages++;
		messageChain = messageChain
			.then(async () => {
				if (!event || typeof event !== "object" || !("data" in event)) return;
				if ((event as { isBinary?: unknown }).isBinary === true) {
					failed = new ProviderProtocolError("Unexpected binary OpenAI Responses WebSocket event");
					done = true;
					return;
				}
				const data = (event as { data?: unknown }).data;
				const text = typeof data === "string"
					? data
					: Buffer.isBuffer(data)
						? data.toString("utf8")
						: ArrayBuffer.isView(data)
							? Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8")
							: null;
				if (text === null) {
					failed = new ProviderProtocolError("Unsupported OpenAI Responses WebSocket message payload");
					done = true;
					return;
				}
				try {
					const parsed = JSON.parse(text) as StreamEventShape;
					const type = typeof parsed.type === "string" ? parsed.type : "";
					if (type === "response.completed" || type === "response.done" || type === "response.incomplete") {
						sawCompletion = true;
						closeError = null;
						done = true;
					}
					if (queue.length >= WEBSOCKET_EVENT_QUEUE_CAPACITY) {
						failed = new ProviderProtocolError(
							`OpenAI Responses WebSocket event queue exceeded ${WEBSOCKET_EVENT_QUEUE_CAPACITY} items`,
						);
						done = true;
						return;
					}
					queue.push(parsed);
				} catch {
					// Match Codex: malformed text frames are logged/ignored rather than
					// tearing down an otherwise healthy response stream.
				}
			})
			.catch((error: unknown) => {
				failed = error instanceof Error ? error : new Error(String(error));
				done = true;
			})
			.finally(() => {
				pendingMessages--;
				wake();
			});
	};

	const onError = (event: unknown) => {
		failed = extractWebSocketError(event);
		done = true;
		wake();
	};

	const onClose = (event: unknown) => {
		if (sawCompletion) {
			done = true;
			wake();
			return;
		}
		if (!closeError) {
			closeError = extractWebSocketCloseError(event);
		}
		done = true;
		wake();
	};

	const onAbort = () => {
		failed = new Error("Request was aborted");
		done = true;
		wake();
	};

	socket.addEventListener("message", onMessage);
	socket.addEventListener("error", onError);
	socket.addEventListener("close", onClose);
	signal?.addEventListener("abort", onAbort);

	try {
		while (true) {
			if (signal?.aborted) {
				throw new Error("Request was aborted");
			}
			if (queue.length > 0) {
				yield queue.shift() as StreamEventShape;
				continue;
			}
			if (done && pendingMessages === 0) break;
			await new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(() => {
					pending = null;
					reject(new Error(`OpenAI Responses WebSocket idle timeout after ${WEBSOCKET_IDLE_TIMEOUT_MS}ms`));
				}, WEBSOCKET_IDLE_TIMEOUT_MS);
				pending = () => {
					clearTimeout(timeout);
					resolve();
				};
			});
		}

		if (failed) throw failed;
		if (closeError && !sawCompletion) throw closeError;
		if (!sawCompletion) {
			throw new Error("WebSocket stream closed before response.completed");
		}
	} finally {
		socket.removeEventListener("message", onMessage);
		socket.removeEventListener("error", onError);
		socket.removeEventListener("close", onClose);
		signal?.removeEventListener("abort", onAbort);
	}
}

async function* startWebSocketOutputOnFirstEvent(
	events: AsyncIterable<StreamEventShape>,
	onStart: () => void,
): AsyncIterable<StreamEventShape> {
	let started = false;
	for await (const event of events) {
		if (!started && event.type !== "error" && event.type !== "response.failed") {
			started = true;
			onStart();
		}
		yield event;
	}
}

async function* countWebSocketEvents(
	events: AsyncIterable<StreamEventShape>,
	onEvent: () => void,
): AsyncIterable<StreamEventShape> {
	for await (const event of events) {
		onEvent();
		yield event;
	}
}

function isRetryableEarlyWebSocketError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /^WebSocket (error|closed)(?:\s|$)/.test(message);
}

function retryAfterMsFromHeaders(headers: Record<string, string> | undefined): number | undefined {
	if (!headers) return undefined;
	const retryAfterMs = Object.entries(headers).find(([name]) => name.toLowerCase() === "retry-after-ms")?.[1];
	if (retryAfterMs) {
		const parsed = Number.parseFloat(retryAfterMs);
		if (Number.isFinite(parsed) && parsed >= 0) return parsed;
	}
	const retryAfter = Object.entries(headers).find(([name]) => name.toLowerCase() === "retry-after")?.[1];
	if (!retryAfter) return undefined;
	const seconds = Number.parseFloat(retryAfter);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
	const date = Date.parse(retryAfter);
	return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function isRetryableWebSocketError(error: unknown): boolean {
	if (error instanceof WebSocketHandshakeError) {
		return isRetryableError(error.status, error.body ?? error.message);
	}
	if (error instanceof ProviderResponseError) {
		if (
			/usage_limit_reached|usage_not_included/i.test(`${error.code ?? ""} ${error.errorType ?? ""}`)
		) {
			return false;
		}
		if (typeof error.status === "number" && isRetryableError(error.status, error.message)) return true;
		return /retry|rate.?limit|overloaded|service.?unavailable|connection.?limit/i.test(
			`${error.code ?? ""} ${error.errorType ?? ""} ${error.message}`,
		);
	}
	if (error instanceof ProviderProtocolError || error instanceof NonRetryableProviderError) return false;
	const message = error instanceof Error ? error.message : String(error);
	return /websocket|network|connection|socket|timed? out|timeout|fetch failed|terminated|closed before response\.completed|stream closed before response\.completed/i.test(
		message,
	);
}

function explicitWebSocketRetryDelayMs(error: unknown): number | undefined {
	return error instanceof WebSocketHandshakeError
		? retryAfterMsFromHeaders(error.headers)
		: error instanceof ProviderResponseError
			? error.retryAfterMs
			: undefined;
}

function boundedWebSocketRetryDelayMs(
	delayMs: number,
	options: SimpleStreamOptions | undefined,
): number {
	const configuredMax = options?.maxRetryDelayMs;
	const maxDelay = typeof configuredMax === "number" && Number.isFinite(configuredMax) && configuredMax >= 0
		? configuredMax
		: WEBSOCKET_RETRY_MAX_DELAY_MS;
	if (maxDelay > 0 && delayMs > maxDelay) {
		throw new NonRetryableProviderError(
			`WebSocket retry delay ${Math.round(delayMs)}ms exceeds maxRetryDelayMs ${Math.round(maxDelay)}ms`,
		);
	}
	return delayMs;
}

function webSocketRetryDelayMs(
	error: unknown,
	retryCount: number,
	options: SimpleStreamOptions | undefined,
): number {
	const explicit = explicitWebSocketRetryDelayMs(error);
	const connectionFailure = !(
		error instanceof WebSocketHandshakeError
		|| error instanceof ProviderResponseError
		|| error instanceof ProviderProtocolError
	);
	const base = explicit
		?? (connectionFailure
			? Math.min(WEBSOCKET_RETRY_MAX_DELAY_MS, 5_000 * 2 ** Math.max(0, retryCount - 1))
			: WEBSOCKET_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, retryCount - 1));
	const jittered = explicit === undefined && !connectionFailure
		? Math.round(base * (0.9 + Math.random() * 0.2))
		: base;
	return boundedWebSocketRetryDelayMs(jittered, options);
}

function webSocketCompactionRetryDelayMs(
	error: unknown,
	retryCount: number,
	options: SimpleStreamOptions | undefined,
): number {
	const explicit = explicitWebSocketRetryDelayMs(error);
	const base = explicit ?? WEBSOCKET_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, retryCount - 1);
	const jittered = explicit === undefined
		? Math.round(base * (0.9 + Math.random() * 0.2))
		: base;
	return boundedWebSocketRetryDelayMs(jittered, options);
}

function webSocketStreamMaxRetries(options: SimpleStreamOptions | undefined): number {
	const value = options?.maxRetries;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return DEFAULT_WEBSOCKET_STREAM_MAX_RETRIES;
	}
	return Math.min(MAX_WEBSOCKET_STREAM_MAX_RETRIES, Math.floor(value));
}

function isProviderNonTransportError(error: unknown): error is ProviderResponseError | ProviderProtocolError {
	return error instanceof ProviderResponseError || error instanceof ProviderProtocolError;
}

function isWebSocketConnectionLimitReachedError(error: unknown): boolean {
	const candidate = error as { code?: unknown; message?: unknown };
	if (candidate?.code === WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE) return true;
	return typeof candidate?.message === "string" && candidate.message.includes(WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE);
}

function isPreviousResponseNotFoundError(error: unknown): boolean {
	const candidate = error as { code?: unknown; message?: unknown };
	if (candidate?.code === PREVIOUS_RESPONSE_NOT_FOUND_CODE) return true;
	return typeof candidate?.message === "string" && candidate.message.includes(PREVIOUS_RESPONSE_NOT_FOUND_CODE);
}

function webSocketHeaderIdentity(headers: Headers): string {
	return shortHash(
		[...headers.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([name, value]) => `${name}:${value}`)
			.join("\n"),
	);
}

function webSocketCacheKey(
	sessionId: string | undefined,
	model: Model<Api>,
	url: string,
	headers: Headers,
	profileHash?: string,
): string | undefined {
	return sessionId
		? `${sessionId}\n${model.provider}\n${model.api}\n${model.id}\n${url}\n${profileHash ?? "no-profile"}\n${webSocketHeaderIdentity(headers)}`
		: undefined;
}

function webSocketFallbackKey(
	sessionId: string | undefined,
	model: Model<Api>,
	url: string,
	profileHash?: string,
): string | undefined {
	return sessionId
		? `${sessionId}\n${model.provider}\n${model.api}\n${model.id}\n${url}\n${profileHash ?? "no-profile"}`
		: undefined;
}

function friendlyUsageLimitMessage(error: StreamEventShape["error"], status: number | undefined): string | undefined {
	const code = error?.code ?? error?.type ?? "";
	if (!/usage_limit_reached|usage_not_included/i.test(code)) {
		return undefined;
	}
	const plan = error?.plan_type ? ` (${error.plan_type.toLowerCase()} plan)` : "";
	const mins = error?.resets_at
		? Math.max(0, Math.round((error.resets_at * 1000 - Date.now()) / 60_000))
		: undefined;
	const when = mins !== undefined ? ` Try again in ~${mins} min.` : "";
	return `You have hit your OpenAI usage limit${plan}.${when}`.trim();
}

async function prewarmWebSocket(request: WebSocketPrewarmRequest): Promise<void> {
	const acquired = await acquireWebSocket(
		request.url,
		request.headers,
		request.cacheKey,
		request.requestMetadata.sessionId,
		request.signal,
		request.connectTimeoutMs ?? WEBSOCKET_CONNECT_TIMEOUT_MS,
	);
	const { socket, entry } = acquired;
	let keepConnection = true;
	let released = false;
	const releaseOnce = (options?: { keep?: boolean }) => {
		if (released) return;
		released = true;
		acquired.release(options);
	};

	try {
		const fullBody = withWebSocketRequestMetadata(request.body, request.requestMetadata);
		const prewarmBody: ResponsesBody = {
			...fullBody,
			generate: false,
		};
		const requestBody = entry ? buildCachedWebSocketRequestBody(entry, prewarmBody) : prewarmBody;
		const wireBody = prepareWebSocketRequestBodyForWire(requestBody);
		await sendWebSocketRequest(
			socket,
			JSON.stringify({ type: "response.create", ...wireBody }),
			request.signal,
			WEBSOCKET_SEND_TIMEOUT_MS,
		);
		const responseItems: unknown[] = [];
		let responseId: string | undefined;
		for await (const event of mapCodexEvents(parseWebSocket(socket, request.signal))) {
			if (event.type === "response.created" && event.response?.id) responseId = event.response.id;
			if (event.type === "response.output_item.done" && event.item) responseItems.push(event.item);
			if (
				(event.type === "response.completed" || event.type === "response.incomplete")
				&& event.response?.id
			) {
				responseId = event.response.id;
			}
		}
		if (entry && responseId) {
			entry.continuation = {
				lastRequestBody: prewarmBody,
				lastResponseId: responseId,
				lastResponseItems: responseItems,
			};
		}
		releaseOnce({ keep: true });
	} catch (error) {
		keepConnection = false;
		if (entry) entry.continuation = undefined;
		releaseOnce({ keep: false });
		throw error;
	} finally {
		releaseOnce({ keep: keepConnection });
	}
}

async function preconnectWebSocket(
	url: string,
	headers: Headers,
	cacheKey: string,
	sessionId: string,
	signal: AbortSignal | undefined,
): Promise<void> {
	const acquired = await acquireWebSocket(
		url,
		headers,
		cacheKey,
		sessionId,
		signal,
		WEBSOCKET_CONNECT_TIMEOUT_MS,
	);
	acquired.release({ keep: true });
}

async function* mapCodexEvents(events: AsyncIterable<StreamEventShape>): AsyncIterable<StreamEventShape> {
	let sawTerminalResponse = false;
	const completedOutputItems = new Set<string>();
	const outputItemKey = (item: unknown, index?: number): string | undefined => {
		if (!item || typeof item !== "object") return undefined;
		const candidate = item as { id?: unknown; type?: unknown };
		if (typeof candidate.id === "string" && typeof candidate.type === "string") return `${candidate.type}:${candidate.id}`;
		return typeof candidate.type === "string" && typeof index === "number" ? `${candidate.type}:index:${index}` : undefined;
	};
	for await (const event of events) {
		const type = typeof event.type === "string" ? event.type : undefined;
		if (!type) continue;

		if (type === "error") {
			const nestedError = event.error;
			const status = typeof event.status === "number"
				? event.status
				: typeof event.status_code === "number"
					? event.status_code
					: undefined;
			const eventHeaders = event.headers && typeof event.headers === "object" && !Array.isArray(event.headers)
				? Object.fromEntries(
						Object.entries(event.headers as Record<string, unknown>)
							.filter((entry): entry is [string, string | number | boolean] =>
								typeof entry[1] === "string" || typeof entry[1] === "number" || typeof entry[1] === "boolean")
							.map(([name, value]) => [name, String(value)]),
					)
				: undefined;
			const code = typeof nestedError?.code === "string"
				? nestedError.code
				: typeof event.code === "string"
					? event.code
					: undefined;
			const message = typeof nestedError?.message === "string"
				? nestedError.message
				: typeof event.message === "string"
					? event.message
					: undefined;
			const displayMessage = friendlyUsageLimitMessage(nestedError, status)
				?? `Codex error: ${message || code || JSON.stringify(event)}`;
			const error = new ProviderResponseError(displayMessage) as ProviderResponseError & {
				sequenceNumber?: number;
			};
			if (code) error.code = code;
			if (typeof nestedError?.type === "string") error.errorType = nestedError.type;
			if (status !== undefined) error.status = status;
			error.retryAfterMs = retryAfterMsFromHeaders(eventHeaders);
			if (typeof event.sequence_number === "number") error.sequenceNumber = event.sequence_number;
			throw error;
		}

		if (type === "response.failed") {
			const responseError = event.response?.error as { code?: unknown; message?: unknown } | undefined;
			const error = new ProviderResponseError(
				typeof responseError?.message === "string" ? responseError.message : "OpenAI Responses request failed",
			);
			if (typeof responseError?.code === "string") error.code = responseError.code;
			throw error;
		}

		if (type === "response.done" || type === "response.completed" || type === "response.incomplete") {
			sawTerminalResponse = true;
			const response = event.response;
			const output = Array.isArray(response?.output) ? response.output : [];
			for (let outputIndex = 0; outputIndex < output.length; outputIndex++) {
				const item = output[outputIndex];
				if (!item || typeof item !== "object") continue;
				const itemType = (item as { type?: unknown }).type;
				if (
					itemType !== "image_generation_call"
					&& itemType !== "web_search_call"
					&& itemType !== "compaction"
					&& itemType !== "context_compaction"
				) continue;
				const key = outputItemKey(item, outputIndex);
				if (key && completedOutputItems.has(key)) continue;
				if (key) completedOutputItems.add(key);
				yield { type: "response.output_item.done", output_index: outputIndex, item } as StreamEventShape;
			}
			yield {
				...event,
				type: "response.completed",
				response: response ? { ...response, status: normalizeCodexStatus(response.status) } : response,
			};
			return;
		}

		if (type === "response.output_item.done") {
			const key = outputItemKey(event.item, typeof event.output_index === "number" ? event.output_index : undefined);
			if (key) completedOutputItems.add(key);
		}

		yield event;
	}

	if (!sawTerminalResponse) {
		throw new Error("Stream closed before response.completed");
	}
}

function normalizeCodexStatus(status: string | undefined): string | undefined {
	if (typeof status !== "string") return undefined;
	return CODEX_RESPONSE_STATUSES.has(status) ? status : undefined;
}

function getLatestUserText(context: Context): string | undefined {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const message = context.messages[i];
		if (message.role !== "user") continue;
		if (typeof message.content === "string") {
			const trimmed = message.content.trim();
			if (trimmed) return trimmed;
			continue;
		}
		const text = message.content
			.filter((item) => item.type === "text")
			.map((item) => item.text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return undefined;
}

async function* captureGeneratedImages(
	events: AsyncIterable<StreamEventShape>,
	options: {
		cwd: string;
		requestPrompt?: string;
		onImageSaved: (image: SavedGeneratedImage, imageData: { data: string; mimeType: string }) => void;
		onWebSearchCaptured?: (search: SurfacedWebSearch) => void;
	},
): AsyncIterable<StreamEventShape> {
	let responseId: string | undefined;

	for await (const event of events) {
		if (event.type === "response.created" && event.response?.id) {
			responseId = event.response.id;
		}

		if (event.type === "response.output_item.done" && event.item?.type === "image_generation_call") {
			const callId = typeof event.item.id === "string" ? event.item.id : undefined;
			const result = typeof event.item.result === "string" ? event.item.result : undefined;
			if (callId && result) {
				try {
					const outputFormat = typeof event.item.output_format === "string" ? event.item.output_format : undefined;
					const normalizedOutputFormat = normalizeImageOutputFormat(outputFormat);
					const settings = loadSettings(options.cwd);
					const imageModel = typeof event.item.model === "string" ? event.item.model : settings.imageModel;
					const saved = await saveOpenAICodexGeneratedImage(options.cwd, {
						responseId,
						callId,
						result,
						outputFormat: normalizedOutputFormat,
						imageModel,
						revisedPrompt:
							typeof event.item.revised_prompt === "string" ? event.item.revised_prompt : options.requestPrompt,
					});
					options.onImageSaved(saved, {
						data: result,
						mimeType: `image/${normalizedOutputFormat}`,
					});
				} catch {
					// Image persistence is best-effort. Do not write raw diagnostics to
					// stdout/stderr from inside the TUI; terminal output can corrupt active
					// widgets and boxes.
				}
			}
		}

		if (
			(event.type === "response.output_item.added" || event.type === "response.output_item.done")
			&& event.item?.type === "web_search_call"
		) {
			const search = extractWebSearch(event.item, { completed: event.type === "response.output_item.done" });
			if (search) {
				options.onWebSearchCaptured?.(search);
			}
		}

		const webSearchProgress = extractWebSearchProgress(event);
		if (webSearchProgress) {
			options.onWebSearchCaptured?.(webSearchProgress);
		}

		yield event;
	}
}

async function processCapturedResponsesStream<TApi extends Api>(
	events: AsyncIterable<StreamEventShape>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<TApi>,
	options: SimpleStreamOptions | undefined,
	deps: {
		onImageSaved?: (savedImage: SavedGeneratedImage, imageData: { data: string; mimeType: string }) => void;
	},
	cwd: string,
	requestPrompt: string | undefined,
	webSearchCitationSources: ReadonlyArray<WebSearchCitationSource>,
	historicalCitationSources: ReadonlyArray<CitationSource>,
): Promise<{ responseId?: string; responseItems: unknown[] }> {
	type TextBlock = Extract<AssistantMessage["content"][number], { type: "text" }>;
	const responseItems: unknown[] = [];
	let responseId: string | undefined;
	const webSearchStates = new Map<string, { search: SurfacedWebSearch; block: TextBlock; contentIndex: number }>();
	const updateWebSearchActivity = (search: SurfacedWebSearch) => {
		const existing = webSearchStates.get(search.callId);
		const merged = mergeWebSearchActivity(existing?.search, search);
		const text = buildWebSearchInlineText(merged, cwd);
		const textSignature = encodeWebSearchActivityTextSignature(merged.callId, merged.responseItem);
		if (existing) {
			existing.search = merged;
			existing.block.text = text;
			existing.block.textSignature = textSignature;
			stream.push({ type: "text_delta", contentIndex: existing.contentIndex, delta: "", partial: output });
			return;
		}

		const block: TextBlock = {
			type: "text",
			text: "",
			textSignature,
		};
		output.content.push(block);
		const contentIndex = output.content.length - 1;
		webSearchStates.set(search.callId, { search: merged, block, contentIndex });
		stream.push({ type: "text_start", contentIndex, partial: output });
		block.text = text;
		stream.push({ type: "text_delta", contentIndex, delta: text, partial: output });
	};
	const captureContinuation = async function* (
		input: AsyncIterable<StreamEventShape>,
	): AsyncIterable<StreamEventShape> {
		for await (const event of input) {
			if (event.type === "response.created" && event.response?.id) responseId = event.response.id;
			if (event.type === "response.output_item.done" && event.item) {
				responseItems.push(event.item);
			}
			if (
				(event.type === "response.completed" || event.type === "response.incomplete")
				&& event.response
			) {
				if (event.response.id) responseId = event.response.id;
			}
			yield event;
		}
	};
	const tappedEvents = captureGeneratedImages(captureContinuation(mapCodexEvents(events)), {
		cwd,
		requestPrompt,
		onImageSaved: (image, imageData) => deps.onImageSaved?.(image, imageData),
		onWebSearchCaptured: updateWebSearchActivity,
	});

	await processResponsesStream(tappedEvents as AsyncIterable<never>, output, stream, model, {
		serviceTier: (options as { serviceTier?: ServiceTier } | undefined)?.serviceTier,
		resolveServiceTier: resolveCodexServiceTier,
		applyServiceTierPricing: (usage, serviceTier) =>
			applyServiceTierPricing(usage, serviceTier, model as Model<Api>, cwd),
		webSearchCitationSources,
		historicalCitationSources,
	});
	return { responseId: responseId ?? output.responseId, responseItems };
}

function compactUrl(baseUrl: string | undefined, apiKeyMode: boolean): string {
	return `${resolveCodexUrl(baseUrl, { apiKeyMode }).replace(/\/+$/, "")}/compact`;
}

function buildJsonHeaders(
	modelHeaders: Record<string, string> | undefined,
	additionalHeaders: Record<string, string> | undefined,
	accountId: string | undefined,
	apiKey: string,
	sessionId?: string,
): Headers {
	const headers = buildBaseCodexHeaders(modelHeaders, additionalHeaders, accountId, apiKey);
	headers.set("accept", "application/json");
	headers.set("content-type", "application/json");
	if (sessionId) {
		headers.set("session_id", sessionId);
		headers.set("x-client-request-id", sessionId);
	}
	return headers;
}

async function postJsonWithRetries(
	url: string,
	headers: Headers,
	body: unknown,
	signal: AbortSignal | undefined,
	timeoutMs = SSE_RESPONSE_HEADER_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
	const bodyJson = JSON.stringify(body);
	const dispatcher = await proxyDispatcherForUrl(url);
	let lastError: Error | undefined;
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		try {
			const response = await fetchWithResponseHeaderTimeout(url, {
				method: "POST",
				headers,
				body: bodyJson,
				...(dispatcher ? { dispatcher } : {}),
			} as RequestInit, signal, timeoutMs);
			if (response.ok) {
				const parsed = await response.json();
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
					throw new NonRetryableProviderError("OpenAI native compaction returned a non-object response");
				}
				return parsed as Record<string, unknown>;
			}
			const errorText = await response.text();
			if (attempt < MAX_RETRIES && isRetryableError(response.status, errorText)) {
				await sleep(BASE_DELAY_MS * 2 ** attempt, signal);
				continue;
			}
			const info = await parseErrorResponse(new Response(errorText, {
				status: response.status,
				statusText: response.statusText,
			}));
			throw new NonRetryableProviderError(withHttpStatusPrefix(response.status, info.friendlyMessage || info.message));
		} catch (error) {
			if (error instanceof NonRetryableProviderError) throw error;
			if (signal?.aborted) throw new Error("Request was aborted");
			lastError = error instanceof Error ? error : new Error(String(error));
			if (attempt < MAX_RETRIES) {
				await sleep(BASE_DELAY_MS * 2 ** attempt, signal);
				continue;
			}
			throw lastError;
		}
	}
	throw lastError ?? new Error("OpenAI native compaction failed");
}

function compactionItems(output: unknown): unknown[] {
	if (!Array.isArray(output)) throw new Error("OpenAI native compaction response omitted output");
	return output.filter(isNativeCompactionItem);
}

function isNativeCompactionItem(item: unknown): item is Record<string, unknown> {
	const type = item && typeof item === "object" ? (item as { type?: unknown }).type : undefined;
	return type === "compaction" || type === "context_compaction";
}

function approxTokenCount(text: string): number {
	const bytes = new TextEncoder().encode(text).byteLength;
	return Math.ceil(bytes / APPROX_BYTES_PER_TOKEN);
}

function responseItemTokenCount(item: Record<string, unknown>): number {
	if (item.type === "message" && Array.isArray(item.content)) {
		const tokens = item.content.reduce((total, part) => {
			if (!part || typeof part !== "object") return total;
			const text = (part as { text?: unknown }).text;
			return typeof text === "string" ? total + approxTokenCount(text) : total;
		}, 0);
		return Math.max(1, tokens);
	}
	try {
		return Math.max(1, approxTokenCount(JSON.stringify(item)));
	} catch {
		return Number.MAX_SAFE_INTEGER;
	}
}

function truncateUtf8Prefix(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const encoder = new TextEncoder();
	if (encoder.encode(text).byteLength <= maxBytes) return text;
	let result = "";
	let bytes = 0;
	for (const character of text) {
		const characterBytes = encoder.encode(character).byteLength;
		if (bytes + characterBytes > maxBytes) break;
		result += character;
		bytes += characterBytes;
	}
	return result;
}

function truncateResponseMessage(
	item: Record<string, unknown>,
	maxTokens: number,
): Record<string, unknown> | undefined {
	if (item.type !== "message" || !Array.isArray(item.content) || maxTokens <= 0) return undefined;
	let remaining = maxTokens;
	const content: unknown[] = [];
	for (const part of item.content) {
		if (!part || typeof part !== "object" || Array.isArray(part)) continue;
		const record = part as Record<string, unknown>;
		if (typeof record.text !== "string") {
			content.push(part);
			continue;
		}
		if (remaining <= 0) continue;
		const tokenCount = approxTokenCount(record.text);
		if (tokenCount <= remaining) {
			content.push(part);
			remaining -= tokenCount;
			continue;
		}
		const text = truncateUtf8Prefix(record.text, remaining * APPROX_BYTES_PER_TOKEN);
		if (text) content.push({ ...record, text });
		remaining = 0;
	}
	return content.length > 0 ? { ...item, content } : undefined;
}

function retainedResponsesCompactionItem(item: unknown): Record<string, unknown> | undefined {
	if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
	const record = item as Record<string, unknown>;
	if (
		(record.type === undefined || record.type === "message")
		&& record.role === "user"
		&& Array.isArray(record.content)
	) {
		return { ...record, type: "message" };
	}
	if (record.type !== "agent_message" || !Array.isArray(record.content)) return undefined;
	const first = record.content[0];
	const firstText = first && typeof first === "object" ? (first as { text?: unknown }).text : undefined;
	if (typeof firstText === "string" && firstText.startsWith("Message Type: FINAL_ANSWER\n")) {
		return undefined;
	}
	return responseItemTokenCount(record) <= CODEX_MAX_RETAINED_AGENT_MESSAGE_TOKENS
		? record
		: undefined;
}

/**
 * Match Codex remote compaction v2's installed checkpoint shape: retain the
 * newest real user messages plus bounded delegated-agent state, drop stale
 * developer/system/assistant/tool state, then append the opaque compaction
 * item returned by Responses.
 */
export function buildCodexCompactionCheckpoint(
	input: unknown[],
	compactionItem: unknown,
): unknown[] {
	const candidates = input
		.map(retainedResponsesCompactionItem)
		.filter((item): item is Record<string, unknown> => !!item);
	let remaining = CODEX_RETAINED_MESSAGE_TOKEN_BUDGET;
	const retainedReversed: Record<string, unknown>[] = [];
	for (let index = candidates.length - 1; index >= 0 && remaining > 0; index--) {
		const item = candidates[index]!;
		const tokenCount = responseItemTokenCount(item);
		if (tokenCount <= remaining) {
			retainedReversed.push(item);
			remaining -= tokenCount;
			continue;
		}
		const truncated = truncateResponseMessage(item, remaining);
		if (truncated) {
			retainedReversed.push(truncated);
			remaining = 0;
		}
	}
	retainedReversed.reverse();
	return [...retainedReversed, compactionItem];
}

interface CodexCompactionStreamResult {
	item: unknown;
	responseId?: string;
	responseItems: unknown[];
}

async function collectCodexCompactionStream(
	events: AsyncIterable<StreamEventShape>,
): Promise<CodexCompactionStreamResult> {
	let outputItemCount = 0;
	const compacted: unknown[] = [];
	const responseItems: unknown[] = [];
	let responseId: string | undefined;
	for await (const event of events) {
		if (event.type === "response.created" && event.response?.id) {
			responseId = event.response.id;
		}
		if (event.type === "response.output_item.done" && event.item) {
			outputItemCount++;
			responseItems.push(event.item);
			if (isNativeCompactionItem(event.item)) compacted.push(event.item);
		}
		if (
			(event.type === "response.completed" || event.type === "response.incomplete")
			&& event.response?.id
		) {
			responseId = event.response.id;
		}
	}
	if (compacted.length !== 1) {
		throw new NonRetryableProviderError(
			`OpenAI compaction trigger expected exactly one compaction item, received ${compacted.length} from ${outputItemCount} output items`,
		);
	}
	return {
		item: compacted[0],
		...(responseId ? { responseId } : {}),
		responseItems,
	};
}

async function collectCodexCompactionOutput(response: Response): Promise<unknown> {
	const result = await collectCodexCompactionStream(mapCodexEvents(parseSSE(response)));
	return result.item;
}

async function requestCodexCompactionTrigger(
	url: string,
	headers: Headers,
	body: ResponsesBody,
	signal: AbortSignal | undefined,
): Promise<unknown> {
	const bodyJson = JSON.stringify(body);
	const dispatcher = await proxyDispatcherForUrl(url);
	let lastError: Error | undefined;
	const maxRetries = Math.min(MAX_RETRIES, CODEX_REMOTE_COMPACTION_STREAM_RETRIES);
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			const response = await fetchWithResponseHeaderTimeout(url, {
				method: "POST",
				headers,
				body: bodyJson,
				...(dispatcher ? { dispatcher } : {}),
			} as RequestInit, signal);
			if (response.ok) return await collectCodexCompactionOutput(response);

			const errorText = await response.text();
			if (attempt < maxRetries && isRetryableError(response.status, errorText)) {
				await sleep(BASE_DELAY_MS * 2 ** attempt, signal);
				continue;
			}
			const info = await parseErrorResponse(new Response(errorText, {
				status: response.status,
				statusText: response.statusText,
			}));
			throw new NonRetryableProviderError(withHttpStatusPrefix(response.status, info.friendlyMessage || info.message));
		} catch (error) {
			if (error instanceof NonRetryableProviderError) throw error;
			if (signal?.aborted) throw new Error("Request was aborted");
			lastError = error instanceof Error ? error : new Error(String(error));
			if (attempt < maxRetries) {
				await sleep(BASE_DELAY_MS * 2 ** attempt, signal);
				continue;
			}
			throw lastError;
		}
	}
	throw lastError ?? new Error("OpenAI compaction trigger failed");
}

async function requestCodexCompactionTriggerWebSocket(
	url: string,
	headers: Headers,
	body: ResponsesBody,
	model: Model<Api>,
	transport: ProviderTransport,
	requestMetadata: WebSocketRequestMetadata,
	signal: AbortSignal | undefined,
	profileHash?: string,
): Promise<unknown> {
	let disableCachedContext = false;
	let staleSocketRetried = false;
	let missingPreviousResponseRetried = false;

	while (true) {
		const cacheKey = webSocketCacheKey(
			requestMetadata.sessionId,
			model,
			url,
			headers,
			profileHash,
		);
		const { socket, entry, release, reused } = await acquireWebSocket(
			url,
			headers,
			cacheKey,
			requestMetadata.sessionId,
			signal,
			WEBSOCKET_CONNECT_TIMEOUT_MS,
		);
		let keepConnection = true;
		let released = false;
		let eventCount = 0;
		const cachedTransport = transport === "websocket-cached" || transport === "auto";
		const warmupContinuation = entry?.continuation?.lastRequestBody.generate === false;
		const useCachedContext = cachedTransport || warmupContinuation;
		const fullBody = withWebSocketRequestMetadata(body, requestMetadata);
		const requestBody = useCachedContext && !disableCachedContext && entry
			? buildCachedWebSocketRequestBody(entry, fullBody)
			: fullBody;
		const wireRequestBody = prepareWebSocketRequestBodyForWire(requestBody);
		const releaseOnce = (releaseOptions?: { keep?: boolean }) => {
			if (released) return;
			released = true;
			release(releaseOptions);
		};

		try {
			await sendWebSocketRequest(
				socket,
				JSON.stringify({ type: "response.create", ...wireRequestBody }),
				signal,
				WEBSOCKET_SEND_TIMEOUT_MS,
			);
			const result = await collectCodexCompactionStream(
				mapCodexEvents(
					countWebSocketEvents(parseWebSocket(socket, signal), () => {
						eventCount++;
					}),
				),
			);
			if (signal?.aborted) {
				keepConnection = false;
				throw new Error("Request was aborted");
			}
			if (cachedTransport && entry && result.responseId) {
				entry.continuation = {
					lastRequestBody: fullBody,
					lastResponseId: result.responseId,
					lastResponseItems: result.responseItems,
				};
			} else if (entry) {
				entry.continuation = undefined;
			}
			releaseOnce({ keep: true });
			return result.item;
		} catch (error) {
			if (entry) entry.continuation = undefined;
			keepConnection = false;
			releaseOnce({ keep: false });
			if (
				!staleSocketRetried
				&& reused
				&& eventCount === 0
				&& !signal?.aborted
				&& isRetryableEarlyWebSocketError(error)
			) {
				staleSocketRetried = true;
				continue;
			}
			if (
				!missingPreviousResponseRetried
				&& requestBody.previous_response_id
				&& !signal?.aborted
				&& isPreviousResponseNotFoundError(error)
			) {
				missingPreviousResponseRetried = true;
				disableCachedContext = true;
				continue;
			}
			throw error;
		} finally {
			releaseOnce({ keep: keepConnection });
		}
	}
}

async function requestCodexCompactionTriggerWithTransport(
	model: Model<Api>,
	headers: {
		sse: Headers;
		websocket: Headers;
	},
	body: ResponsesBody,
	options: {
		sessionId?: string;
		turnId?: string;
		signal?: AbortSignal;
		settings: ResolvedCodexModelSettings;
		maxRetries?: number;
		maxRetryDelayMs?: number;
	},
): Promise<unknown> {
	const transport = options.settings.openaiTransport;
	const responsesMode = resolveCodexRequestProfile(options.settings.requestProfile).responsesMode;
	const sseUrl = resolveCodexUrl(model.baseUrl, { apiKeyMode: options.settings.apiKeyMode });
	if (transport === "sse") {
		return requestCodexCompactionTrigger(sseUrl, headers.sse, body, options.signal);
	}

	const websocketUrl = resolveResponsesWebSocketUrl(model.baseUrl, { apiKeyMode: options.settings.apiKeyMode });
	const fallbackKey = webSocketFallbackKey(
		options.sessionId,
		model,
		websocketUrl,
		options.settings.modelProfileHash,
	);
	if (
		transport === "auto"
		&& fallbackKey
		&& websocketHttpFallbackSessions.has(fallbackKey)
	) {
		return requestCodexCompactionTrigger(sseUrl, headers.sse, body, options.signal);
	}

	const requestMetadata: WebSocketRequestMetadata = {
		...(options.sessionId ? { sessionId: options.sessionId, threadId: options.sessionId } : {}),
		turnId: options.turnId || createPiTurnId(),
	};
	const maxRetries = Math.min(
		CODEX_REMOTE_COMPACTION_STREAM_RETRIES,
		webSocketStreamMaxRetries({
			maxRetries: options.maxRetries,
		} as SimpleStreamOptions),
	);
	const retryOptions = {
		...(options.maxRetryDelayMs !== undefined ? { maxRetryDelayMs: options.maxRetryDelayMs } : {}),
	} as SimpleStreamOptions;
	let retries = 0;
	while (true) {
		try {
			return await requestCodexCompactionTriggerWebSocket(
				websocketUrl,
				headers.websocket,
				withResponsesLiteWebSocketMetadata(body, responsesMode),
				model,
				transport,
				requestMetadata,
				options.signal,
				options.settings.modelProfileHash,
			);
		} catch (error) {
			if (options.signal?.aborted) throw new Error("Request was aborted");
			const upgradeRequired = error instanceof WebSocketHandshakeError && error.status === 426;
			const retryable = isWebSocketConnectionLimitReachedError(error) || isRetryableWebSocketError(error);
			if (!upgradeRequired && retryable && retries < maxRetries) {
				retries++;
				await sleep(webSocketCompactionRetryDelayMs(error, retries, retryOptions), options.signal);
				continue;
			}
			if (transport !== "auto" || (!upgradeRequired && !retryable)) {
				throw error;
			}
			if (fallbackKey) websocketHttpFallbackSessions.add(fallbackKey);
			break;
		}
	}

	return requestCodexCompactionTrigger(sseUrl, headers.sse, body, options.signal);
}

function hasNonEmptyResponseMessageContent(item: Record<string, unknown>): boolean {
	if (item.type !== "message") return false;
	if (item.role !== "user" && item.role !== "assistant") return false;
	if (!Array.isArray(item.content)) return false;
	return item.content.some((part) => {
		if (!part || typeof part !== "object") return false;
		const content = part as Record<string, unknown>;
		return (
			(typeof content.text === "string" && content.text.trim().length > 0)
			|| (typeof content.refusal === "string" && content.refusal.trim().length > 0)
			|| typeof content.image_url === "string"
		);
	});
}

/**
 * Install remote compaction as a fresh history checkpoint, following Codex's
 * compaction reducer: preserve only safe message/checkpoint items and discard
 * reasoning, tool calls, and tool outputs. Replaying a partial call pair is
 * invalid Responses input and can detach tool arguments from their result.
 */
export function sanitizeNativeCompactionOutput(output: unknown[]): unknown[] {
	return output.filter((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return false;
		const record = item as Record<string, unknown>;
		if (record.type === "compaction" || record.type === "context_compaction") return true;
		return hasNonEmptyResponseMessageContent(record);
	});
}

export async function requestOpenAINativeCompaction(
	model: Model<Api>,
	context: Context,
	options: {
		mode: "responses" | "responses-compact";
		apiKey: string;
		headers?: Record<string, string>;
		signal?: AbortSignal;
		reasoning?: SimpleStreamOptions["reasoning"];
		sessionId?: string;
		turnId?: string;
		maxRetries?: number;
		maxRetryDelayMs?: number;
		settings: ResolvedCodexModelSettings;
	},
): Promise<unknown[]> {
	const settings = options.settings.modelProfile
		? options.settings
		: loadModelSettings(model, undefined, options.settings);
	const auth = { apiKey: options.apiKey || undefined, headers: options.headers };
	if (!hasCodexRequestAuth({ modelHeaders: model.headers, auth })) {
		throw new Error(`No request authentication for provider: ${model.provider}`);
	}
	if (settings.compactionMode === "pi") {
		throw new Error("native compaction is disabled by the current model profile");
	}
	const profile = resolveCodexRequestProfile(settings.requestProfile);
	const accountId = resolveCodexRequestAccountId({
		modelHeaders: model.headers,
		auth,
		apiKeyMode: settings.apiKeyMode,
	});
	let body = applyFastModeServiceTier(buildRequestBody(model, context, profile, {
		apiKey: options.apiKey,
		headers: options.headers,
		signal: options.signal,
		reasoning: options.reasoning,
		sessionId: options.sessionId,
	}), settings, model);
	if (settings.nativeProviderTools) {
		const webSearch = settings.modelProfile?.effective.tools.webSearch;
		body = rewriteNativeOpenAiTools(body, {
			imageModel: settings.imageModel,
			imageGeneration: settings.imageGenerationImplementation ?? false,
			webSearch: settings.webSearchEnabled
				&& webSearch
				? {
						implementation: webSearch.implementation,
						contentTypes: webSearch.contentTypes,
					}
				: false,
		}).payload;
	}
	ensureWebSearchDetailsIncluded(body);

	if (options.mode === "responses") {
		const retainedInput = [...body.input];
		body.input = [...retainedInput, { type: CODEX_COMPACTION_TRIGGER_TYPE }];
		const sseHeaders = applyConfiguredResponsesFeatureHeaders(buildSSEHeaders(
			model.headers,
			options.headers,
			accountId,
			options.apiKey,
			options.sessionId,
			profile,
		), settings, model);
		const requestId = options.sessionId || createCodexRequestId();
		const websocketHeaders = applyConfiguredResponsesFeatureHeaders(buildWebSocketHeaders(
			model.headers,
			options.headers,
			accountId,
			options.apiKey,
			requestId,
			requestId,
		), settings, model);
		const item = await requestCodexCompactionTriggerWithTransport(
			model,
			{ sse: sseHeaders, websocket: websocketHeaders },
			body,
			{
				sessionId: options.sessionId,
				turnId: options.turnId,
				signal: options.signal,
				settings,
				maxRetries: options.maxRetries,
				maxRetryDelayMs: options.maxRetryDelayMs,
			},
		);
		return buildCodexCompactionCheckpoint(retainedInput, item);
	}

	const headers = buildJsonHeaders(
		model.headers,
		options.headers,
		accountId,
		options.apiKey,
		options.sessionId,
	);
	if (profile.responsesMode === "lite") {
		headers.set(X_OPENAI_INTERNAL_CODEX_RESPONSES_LITE, "true");
	}
	const compactBody: Record<string, unknown> = {
		model: body.model,
		input: body.input,
		parallel_tool_calls: body.parallel_tool_calls,
	};
	for (const key of ["instructions", "tools", "reasoning", "service_tier", "prompt_cache_key", "text"] as const) {
		if (body[key] !== undefined) compactBody[key] = body[key];
	}
	const response = await postJsonWithRetries(
		compactUrl(model.baseUrl, settings.apiKeyMode),
		headers,
		compactBody,
		options.signal,
	);
	const output = response.output;
	if (!Array.isArray(output) || output.length === 0) {
		throw new Error("OpenAI /responses/compact returned no replacement output");
	}
	const sanitizedOutput = sanitizeNativeCompactionOutput(output);
	if (compactionItems(sanitizedOutput).length === 0) {
		throw new Error("OpenAI /responses/compact output did not contain a compaction item");
	}
	return sanitizedOutput;
}

async function processWebSocketStream<TApi extends Api>(
	url: string,
	body: ResponsesBody,
	headers: Headers,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<TApi>,
	onStart: () => void,
	transport: ProviderTransport,
	options: SimpleStreamOptions | undefined,
	deps: {
		onImageSaved?: (savedImage: SavedGeneratedImage, imageData: { data: string; mimeType: string }) => void;
	},
	cwd: string,
	requestPrompt: string | undefined,
	webSearchCitationSources: ReadonlyArray<WebSearchCitationSource>,
	historicalCitationSources: ReadonlyArray<CitationSource>,
	requestMetadata: WebSocketRequestMetadata,
	profileHash?: string,
): Promise<void> {
	let streamStarted = false;
	let disableCachedContext = false;
	let staleSocketRetried = false;
	let missingPreviousResponseRetried = false;

	while (true) {
		const cacheKey = webSocketCacheKey(
			options?.sessionId,
			model as Model<Api>,
			url,
			headers,
			profileHash,
		);
		const { socket, entry, release, reused } = await acquireWebSocket(
			url,
			headers,
			cacheKey,
			options?.sessionId,
			options?.signal,
			WEBSOCKET_CONNECT_TIMEOUT_MS,
		);
		let keepConnection = true;
		let released = false;
		let eventCount = 0;
		const cachedTransport = transport === "websocket-cached" || transport === "auto";
		const warmupContinuation = entry?.continuation?.lastRequestBody.generate === false;
		const useCachedContext = cachedTransport || warmupContinuation;
		// ChatGPT Codex Responses rejects `store: true` ("Store must be set to false").
		// WebSocket continuation still works via connection-scoped previous_response_id state.
		const fullBody = withWebSocketRequestMetadata(body, requestMetadata);
		const requestBody = useCachedContext && !disableCachedContext && entry
			? buildCachedWebSocketRequestBody(entry, fullBody)
			: fullBody;
		const wireRequestBody = prepareWebSocketRequestBodyForWire(requestBody);

		const releaseOnce = (releaseOptions?: { keep?: boolean }) => {
			if (released) return;
			released = true;
			release(releaseOptions);
		};

		try {
			await sendWebSocketRequest(
				socket,
				JSON.stringify({ type: "response.create", ...wireRequestBody }),
				options?.signal,
				WEBSOCKET_SEND_TIMEOUT_MS,
			);
			const startOutput = () => {
				if (streamStarted) return;
				onStart();
				stream.push({ type: "start", partial: output });
				streamStarted = true;
			};
			const continuationResult = await processCapturedResponsesStream(
				startWebSocketOutputOnFirstEvent(
					countWebSocketEvents(parseWebSocket(socket, options?.signal), () => {
						eventCount++;
					}),
					startOutput,
				),
				output,
				stream,
				model,
				options,
				deps,
				cwd,
				requestPrompt,
				webSearchCitationSources,
				historicalCitationSources,
			);
			if (options?.signal?.aborted) {
				keepConnection = false;
			} else if (cachedTransport && entry && continuationResult.responseId) {
				entry.continuation = {
					lastRequestBody: fullBody,
					lastResponseId: continuationResult.responseId,
					lastResponseItems: continuationResult.responseItems,
				};
			} else if (entry) {
				entry.continuation = undefined;
			}
			releaseOnce({ keep: keepConnection });
			return;
		} catch (error) {
			if (entry) {
				entry.continuation = undefined;
			}
			keepConnection = false;
			releaseOnce({ keep: false });
			// Pi's stock provider reuses session WebSockets. In practice the Codex
			// backend sometimes cleanly closes an idle cached socket between turns;
			// if that stale socket fails before any response event, retry once on a
			// fresh WebSocket without changing request shape or falling back transports.
			if (!staleSocketRetried && reused && eventCount === 0 && !options?.signal?.aborted && isRetryableEarlyWebSocketError(error)) {
				staleSocketRetried = true;
				continue;
			}
			if (
				!missingPreviousResponseRetried
				&& requestBody.previous_response_id
				&& !streamStarted
				&& !options?.signal?.aborted
				&& isPreviousResponseNotFoundError(error)
			) {
				missingPreviousResponseRetried = true;
				disableCachedContext = true;
				continue;
			}
			throw error;
		} finally {
			releaseOnce({ keep: keepConnection });
		}
	}
}

export function extractWebSearch(
	item: StreamEventShape["item"],
	options?: { completed?: boolean },
): SurfacedWebSearch | undefined {
	if (!item || item.type !== "web_search_call") return undefined;
	const callId = typeof item.id === "string" ? item.id : typeof item.call_id === "string" ? item.call_id : undefined;
	if (!callId) return undefined;

	const action = typeof item.action === "object" && item.action !== null ? (item.action as Record<string, unknown>) : undefined;
	const actionType = typeof action?.type === "string" ? action.type : undefined;
	const query = typeof action?.query === "string" ? action.query : typeof item.query === "string" ? item.query : undefined;
	const queries = [
		...(Array.isArray(action?.queries) ? action.queries : []),
		...(Array.isArray(item.queries) ? item.queries : []),
	].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
	const url = typeof action?.url === "string" && action.url.trim()
		? action.url.trim()
		: typeof item.url === "string" && item.url.trim()
			? item.url.trim()
			: undefined;
	const pattern = typeof action?.pattern === "string" && action.pattern.trim() ? action.pattern.trim() : undefined;

	const asRecordArray = (value: unknown): Record<string, unknown>[] => Array.isArray(value)
		? value
				.map((entry) => typeof entry === "object" && entry !== null ? entry as Record<string, unknown> : undefined)
				.filter((entry): entry is Record<string, unknown> => !!entry)
		: [];
	const sourceCandidates = [
		...asRecordArray(action?.sources),
		...asRecordArray(action?.results),
		...asRecordArray(item.results),
	];
	if (typeof item.url === "string") sourceCandidates.push(item as Record<string, unknown>);

	const seenUrls = new Set<string>();
	const sources: Array<{ title?: string; url: string }> = [];
	for (const source of sourceCandidates) {
		const url = typeof source.url === "string" && source.url.trim() ? source.url.trim() : undefined;
		if (!url || seenUrls.has(url)) continue;
		seenUrls.add(url);
		const title = typeof source.title === "string" && source.title.trim() ? source.title.trim() : undefined;
		sources.push({ ...(title ? { title } : {}), url });
	}

	return {
		callId,
		...(typeof item.status === "string" ? { status: item.status } : {}),
		...(options?.completed !== undefined ? { completed: options.completed } : {}),
		...(actionType ? { actionType } : {}),
		...(query ? { query } : {}),
		queries,
		...(url ? { url } : {}),
		...(pattern ? { pattern } : {}),
		sources,
		...(options?.completed ? { responseItem: item as Record<string, unknown> } : {}),
	};
}

export function extractWebSearchProgress(event: StreamEventShape): SurfacedWebSearch | undefined {
	const status = event.type === "response.web_search_call.in_progress"
		? "in_progress"
		: event.type === "response.web_search_call.searching"
			? "searching"
			: event.type === "response.web_search_call.completed"
				? "completed"
				: undefined;
	if (!status || typeof event.item_id !== "string" || !event.item_id) return undefined;
	return {
		callId: event.item_id,
		status,
		completed: status === "completed",
		queries: [],
		sources: [],
	};
}

export function mergeWebSearchActivity(
	previous: SurfacedWebSearch | undefined,
	next: SurfacedWebSearch,
): SurfacedWebSearch {
	if (!previous) return next;
	const seenUrls = new Set<string>();
	const sources = [...next.sources, ...previous.sources].filter((source) => {
		if (seenUrls.has(source.url)) return false;
		seenUrls.add(source.url);
		return true;
	});
	const completed = Boolean(previous.completed || next.completed);
	return {
		callId: next.callId,
		status: previous.completed && !next.completed ? previous.status : (next.status ?? previous.status),
		completed,
		actionType: next.actionType ?? previous.actionType,
		query: next.query ?? previous.query,
		queries: next.queries.length > 0 ? next.queries : previous.queries,
		url: next.url ?? previous.url,
		pattern: next.pattern ?? previous.pattern,
		sources,
		responseItem: next.responseItem ?? previous.responseItem,
	};
}

export function webSearchActivityDetail(search: SurfacedWebSearch): string {
	if (search.actionType === "open_page") return search.url ?? "";
	if (search.actionType === "find_in_page") {
		if (search.pattern && search.url) return `'${search.pattern}' in ${search.url}`;
		if (search.pattern) return `'${search.pattern}'`;
		return search.url ?? "";
	}
	const query = search.query?.trim();
	if (query) return query;
	const first = search.queries[0]?.trim() ?? "";
	return search.queries.length > 1 && first ? `${first} ...` : first;
}

export function webSearchActivityHosts(search: SurfacedWebSearch): string[] {
	const seen = new Set<string>();
	const hosts: string[] = [];
	for (const source of search.sources) {
		try {
			const host = new URL(source.url).hostname.replace(/^www\./i, "");
			const key = host.toLowerCase();
			if (!host || seen.has(key)) continue;
			seen.add(key);
			hosts.push(host);
		} catch {
			// Sources without a valid URL do not produce a host tag.
		}
	}
	return hosts;
}

export function buildWebSearchStatusText(search: SurfacedWebSearch): string {
	const completed = search.completed ?? search.status === "completed";
	const detail = webSearchActivityDetail(search);
	if (completed) return `Searched the web${detail ? ` for ${detail}` : ""}`;
	return `Searching the web${detail ? ` ${detail}` : ""}`;
}

export function buildWebSearchInlineText(search: SurfacedWebSearch, cwd?: string): string {
	const completed = search.completed ?? search.status === "completed";
	const header = completed ? "Searched the web" : "Searching the web";
	const detail = webSearchActivityDetail(search);
	const separator = detail ? (completed ? " for " : " ") : "";
	return `${glyphs(cwd).bullet}**${header}**${separator}${detail}`;
}

export function buildWebSearchActivityMessage(searches: SurfacedWebSearch[]): string {
	const sections = searches.map((search, index) => {
		const heading = searches.length > 1
			? `${index + 1}. ${buildWebSearchStatusText(search)}`
			: buildWebSearchStatusText(search);
		const lines = [heading, `Call: ${search.callId}${search.status ? ` (${search.status})` : ""}`];
		const queries = search.queries.length > 0 ? search.queries : search.query ? [search.query] : [];
		if (queries.length > 0) {
			lines.push(`Query: ${queries.join(" | ")}`);
		}
		if (search.sources.length > 0) {
			lines.push("Sources:");
			for (const source of search.sources.slice(0, 8)) {
				lines.push(`- ${source.title ? `${source.title}: ` : ""}${source.url}`);
			}
		}
		return lines.join("\n");
	});

	return sections.join("\n\n");
}

export function buildWebSearchSummaryText(searches: SurfacedWebSearch[]): string {
	if (searches.length === 0) return "Web search";
	if (searches.length === 1) return buildWebSearchStatusText(searches[0]!);
	const completed = searches.filter((search) => search.completed ?? search.status === "completed").length;
	if (completed === searches.length) return `Searched the web ${searches.length} times`;
	if (completed === 0) return `Searching the web (${searches.length} calls)`;
	return `Web search activity (${completed}/${searches.length} completed)`;
}

function makeCachedImagePreview(data: string, mimeType: string, bytes?: number): CachedImagePreview {
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

function themeFg(theme: any, token: string, text: string): string {
	try { return theme?.fg?.(token, text) ?? text; } catch { return text; }
}

function themeBold(theme: any, text: string): string {
	try { return theme?.bold?.(text) ?? text; } catch { return text; }
}

function shouldRenderInlineImage(): { ok: boolean; reason?: string } {
	if (process.env.TMUX) return { ok: false, reason: "inline preview disabled in tmux to avoid overlay/stale image artifacts" };
	const protocol = getCapabilities().images;
	if (!protocol) return { ok: false, reason: "terminal image protocol unavailable" };
	return { ok: true };
}

function renderImageGenerationMessage(savedImage: SavedGeneratedImage | undefined, messageContent: unknown, options: any, theme: any, imagePreviewCache: Map<string, CachedImagePreview>): Container {
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

function createInitialAssistantMessage<TApi extends Api>(model: Model<TApi>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createErrorMessage(message: AssistantMessage, error: unknown, aborted: boolean): AssistantMessage {
	for (const block of message.content) {
		if (typeof block === "object" && block !== null && "partialJson" in block) {
			delete (block as { partialJson?: string }).partialJson;
		}
	}
	message.stopReason = aborted ? "aborted" : "error";
	message.errorMessage = buildProviderErrorMessage(error);
	return message;
}

export function buildProviderErrorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const candidate = error as { code?: unknown; errorType?: unknown; status?: unknown };
	if (
		candidate?.code === "stream_read_error"
		&& candidate.errorType === "upstream_error"
	) {
		// Pi's agent-level retry classifier recognizes "connection error". Surface
		// this upstream SSE read failure in that category instead of
		// retrying inside the provider, so Pi's retry settings and UI remain the
		// single source of truth.
		return `Connection error: ${message}`;
	}
	if (/^(?:WebSocket (?:error|closed)|WebSocket stream closed before response\.completed|Stream closed before response\.completed)/.test(message)) {
		return `Connection error: ${message}`;
	}
	if (typeof candidate?.status === "number") {
		return withHttpStatusPrefix(candidate.status, message);
	}
	return message;
}

function finalizeUsage<TApi extends Api>(model: Model<TApi>, output: AssistantMessage): void {
	output.usage.cost.total = output.usage.cost.input + output.usage.cost.output + output.usage.cost.cacheRead + output.usage.cost.cacheWrite;
}

async function parseErrorResponse(response: Response): Promise<{ message: string; friendlyMessage?: string }> {
	const raw = await response.text();
	let message = raw || response.statusText || "Request failed";
	let friendlyMessage: string | undefined;

	try {
		const parsed = JSON.parse(raw) as { error?: { code?: string; type?: string; plan_type?: string; resets_at?: number; message?: string } };
		const err = parsed?.error;
		if (err) {
			const code = err.code || err.type || "";
			if (/usage_limit_reached|usage_not_included|rate_limit_exceeded/i.test(code) || response.status === 429) {
				const plan = err.plan_type ? ` (${err.plan_type.toLowerCase()} plan)` : "";
				const mins = err.resets_at ? Math.max(0, Math.round((err.resets_at * 1000 - Date.now()) / 60000)) : undefined;
				const when = mins !== undefined ? ` Try again in ~${mins} min.` : "";
				friendlyMessage = `You have hit your ChatGPT usage limit${plan}.${when}`.trim();
			}
			message = err.message || friendlyMessage || message;
		}
	} catch {
		// ignore malformed error bodies
	}

	return { message, friendlyMessage };
}

function createCodexStream<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	deps: {
		getCurrentCwd: () => string;
		getCurrentTurnId?: (sessionId: string | undefined) => string | undefined;
		onImageSaved?: (savedImage: SavedGeneratedImage, imageData: { data: string; mimeType: string }) => void;
	},
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const requestCwd = deps.getCurrentCwd();

	(async () => {
		const output = createInitialAssistantMessage(model);
		const requestPrompt = getLatestUserText(context);
		const webSearchCitationSources = collectWebSearchCitationSources(model, context);
		const historicalCitationSources = collectHistoricalCitationSources(model, context);

		try {
			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			const auth = { apiKey: apiKey || undefined, headers: options?.headers };
			if (!hasCodexRequestAuth({ modelHeaders: model.headers, auth })) {
				throw new Error(`No request authentication for provider: ${model.provider}`);
			}

			const settings = loadModelSettings(model, requestCwd);
			const requestProfile = resolveCodexRequestProfile(settings.requestProfile);
			if (
				!settings.enabled
				|| !settings.modelProfile?.effective.enabled
				|| !settings.providerShimActive
			) {
				throw new Error(`No enabled Codex model profile for ${model.provider}/${model.id}`);
			}
			const apiKeyTransport = settings.apiKeyMode;
			const accountId = resolveCodexRequestAccountId({
				modelHeaders: model.headers,
				auth,
				apiKeyMode: apiKeyTransport,
			});
			let body = applyFastModeServiceTier(
				buildRequestBody(model, context, requestProfile, options),
				settings,
				model,
			);
			const nextBody = await options?.onPayload?.(body, model);
			if (nextBody !== undefined) {
				body = nextBody as ResponsesBody;
			}
			if (settings.nativeProviderTools) {
				const webSearch = settings.modelProfile.effective.tools.webSearch;
				body = rewriteNativeOpenAiTools(body, {
					imageModel: settings.imageModel,
					imageGeneration: settings.imageGenerationImplementation ?? false,
					webSearch: settings.webSearchEnabled && webSearch
						? {
								implementation: webSearch.implementation,
								contentTypes: webSearch.contentTypes,
							}
						: false,
				}).payload;
			}
			options = withRequestServiceTier(options, body.service_tier);
			ensureWebSearchDetailsIncluded(body);

			const optionMetadata = options?.metadata;
			const metadataString = (key: string): string | undefined => {
				const value = optionMetadata?.[key];
				return typeof value === "string" && value.trim() ? value.trim() : undefined;
			};
			const websocketSessionId = metadataString("session_id") ?? options?.sessionId;
			const websocketThreadId = metadataString("thread_id") ?? options?.sessionId;
			const websocketTurnId = metadataString("turn_id")
				?? deps.getCurrentTurnId?.(options?.sessionId)
				?? createPiTurnId();
			const websocketRequestId = websocketThreadId || websocketSessionId || createCodexRequestId();
			const websocketRequestMetadata: WebSocketRequestMetadata = {
				...(websocketSessionId ? { sessionId: websocketSessionId } : {}),
				...(websocketThreadId ? { threadId: websocketThreadId } : {}),
				turnId: websocketTurnId,
			};
			const sseHeaders = applyConfiguredResponsesFeatureHeaders(
				buildSSEHeaders(model.headers, options?.headers, accountId, apiKey, options?.sessionId, requestProfile),
				settings,
				model as Model<Api>,
			);
			const websocketHeaders = applyConfiguredResponsesFeatureHeaders(buildWebSocketHeaders(
				model.headers,
				options?.headers,
				accountId,
				apiKey,
				websocketSessionId || websocketRequestId,
				websocketThreadId || websocketRequestId,
			), settings, model as Model<Api>);
			const bodyJson = JSON.stringify(body);
			const responseHeaderTimeoutMs = responseHeaderTimeoutMsFromOptions(options);
			const transport: ProviderTransport = settings.openaiTransport;

			const websocketUrl = resolveResponsesWebSocketUrl(model.baseUrl, { apiKeyMode: apiKeyTransport });
			const fallbackKey = webSocketFallbackKey(
				options?.sessionId,
				model as Model<Api>,
				websocketUrl,
				settings.modelProfileHash,
			);
			const sessionFellBackToHttp = transport === "auto"
				&& fallbackKey !== undefined
				&& websocketHttpFallbackSessions.has(fallbackKey);

			if (transport !== "sse" && !sessionFellBackToHttp) {
				const websocketBody = withResponsesLiteWebSocketMetadata(body, requestProfile.responsesMode);
				let websocketStarted = false;
				let websocketRetries = 0;
				const maxWebSocketRetries = webSocketStreamMaxRetries(options);
				while (true) {
					websocketStarted = false;
					try {
						await processWebSocketStream(
							websocketUrl,
							websocketBody,
							websocketHeaders,
							output,
							stream,
							model,
							() => {
								websocketStarted = true;
							},
							transport,
							options,
							deps,
							requestCwd,
							requestPrompt,
							webSearchCitationSources,
							historicalCitationSources,
							websocketRequestMetadata,
							settings.modelProfileHash,
						);
						if (options?.signal?.aborted) {
							throw new Error("Request was aborted");
						}
						finalizeUsage(model, output);
						stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
						stream.end();
						return;
					} catch (error) {
						const aborted = options?.signal?.aborted;
						const upgradeRequired = error instanceof WebSocketHandshakeError && error.status === 426;
						const retryableTransport = !aborted
							&& (isWebSocketConnectionLimitReachedError(error) || isRetryableWebSocketError(error));
						const retryableBeforeStart = !websocketStarted && retryableTransport;
						if (retryableBeforeStart && websocketRetries < maxWebSocketRetries) {
							websocketRetries++;
							await sleep(webSocketRetryDelayMs(error, websocketRetries, options), options?.signal);
							continue;
						}
						if (
							transport === "auto"
							&& fallbackKey
							&& websocketStarted
							&& retryableTransport
						) {
							websocketHttpFallbackSessions.add(fallbackKey);
							appendAssistantMessageDiagnostic(
								output,
								createAssistantMessageDiagnostic("provider_transport_failure", error, {
									configuredTransport: transport,
									fallbackTransport: "sse",
									eventsEmitted: true,
									phase: "fallback_on_next_agent_retry",
									retries: websocketRetries,
									requestBytes: new TextEncoder().encode(bodyJson).byteLength,
								}),
							);
							throw error;
						}
						if (
							transport === "auto"
							&& fallbackKey
							&& !websocketStarted
							&& (upgradeRequired || retryableBeforeStart)
						) {
							websocketHttpFallbackSessions.add(fallbackKey);
							appendAssistantMessageDiagnostic(
								output,
								createAssistantMessageDiagnostic("provider_transport_failure", error, {
									configuredTransport: transport,
									fallbackTransport: "sse",
									eventsEmitted: false,
									phase: upgradeRequired ? "websocket_upgrade_rejected" : "websocket_retries_exhausted",
									retries: websocketRetries,
									requestBytes: new TextEncoder().encode(bodyJson).byteLength,
								}),
							);
							break;
						}
						if (aborted || (isProviderNonTransportError(error) && !isWebSocketConnectionLimitReachedError(error))) {
							throw error;
						}
						appendAssistantMessageDiagnostic(
							output,
							createAssistantMessageDiagnostic("provider_transport_failure", error, {
								configuredTransport: transport,
								fallbackTransport: websocketStarted ? undefined : "sse",
								eventsEmitted: websocketStarted,
								phase: websocketStarted ? "after_message_stream_start" : "before_message_stream_start",
								requestBytes: new TextEncoder().encode(bodyJson).byteLength,
							}),
						);
						if (transport === "websocket" || transport === "websocket-cached" || websocketStarted) {
							throw error;
						}
						break;
					}
				}
			}

			let response: Response | undefined;
			let lastError: Error | undefined;
			const sseUrl = resolveCodexUrl(model.baseUrl, { apiKeyMode: apiKeyTransport });
			const sseDispatcher = await proxyDispatcherForUrl(sseUrl);

			for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
				if (options?.signal?.aborted) {
					throw new Error("Request was aborted");
				}

				try {
					response = await fetchWithResponseHeaderTimeout(sseUrl, {
						method: "POST",
						headers: sseHeaders,
						body: bodyJson,
						...(sseDispatcher ? { dispatcher: sseDispatcher } : {}),
					} as RequestInit, options?.signal, responseHeaderTimeoutMs);

					await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);

					if (response.ok) {
						break;
					}

					const errorText = await response.text();
					if (attempt < MAX_RETRIES && isRetryableError(response.status, errorText)) {
						await sleep(BASE_DELAY_MS * 2 ** attempt, options?.signal);
						continue;
					}

					const fakeResponse = new Response(errorText, {
						status: response.status,
						statusText: response.statusText,
					});
					const info = await parseErrorResponse(fakeResponse);
					throw new NonRetryableProviderError(withHttpStatusPrefix(response.status, info.friendlyMessage || info.message));
				} catch (error) {
					if (error instanceof NonRetryableProviderError) {
						throw error;
					}
					if (error instanceof Error && (error.name === "AbortError" || error.message === "Request was aborted")) {
						throw new Error("Request was aborted");
					}

					lastError = error instanceof Error ? error : new Error(String(error));
					if (attempt < MAX_RETRIES && !lastError.message.includes("usage limit")) {
						await sleep(BASE_DELAY_MS * 2 ** attempt, options?.signal);
						continue;
					}
					throw lastError;
				}
			}

			if (!response?.ok) {
				throw lastError ?? new Error("Failed after retries");
			}

			if (!response.body) {
				throw new Error("No response body");
			}

			stream.push({ type: "start", partial: output });
			await processCapturedResponsesStream(
				parseSSE(response),
				output,
				stream,
				model,
				options,
				deps,
				requestCwd,
				requestPrompt,
				webSearchCitationSources,
				historicalCitationSources,
			);
			finalizeUsage(model, output);

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
			stream.end();
		} catch (error) {
			stream.push({
				type: "error",
				reason: (options?.signal?.aborted ? "aborted" : "error") as "aborted" | "error",
				error: createErrorMessage(output, error, !!options?.signal?.aborted),
			});
			stream.end();
		}
	})();

	return stream;
}

export function registerOpenAIResponsesProviders(
	pi: ExtensionAPI,
	options: { getCurrentCwd: () => string },
): OpenAIResponsesProviderController {
	const pendingActivities: PendingActivity[] = [];
	const imagePreviewCache = new Map<string, CachedImagePreview>();
	const activeTurnIds = new Map<string, string>();
	let pendingFlushTimer: ReturnType<typeof setTimeout> | undefined;

	const flushPendingMessages = () => {
		pendingFlushTimer = undefined;
		const activities = pendingActivities.splice(0, pendingActivities.length);

		for (const activity of activities) {
			imagePreviewCache.set(activity.savedImage.absolutePath, makeCachedImagePreview(activity.imageData.data, activity.imageData.mimeType));
			pi.sendMessage(
				{
					customType: IMAGE_SAVE_DISPLAY_MESSAGE_TYPE,
					content: [{ type: "text", text: buildGeneratedImageDisplayText(activity.savedImage, { expanded: false }) }],
					display: true,
					details: { savedImages: [activity.savedImage] } satisfies ImageDisplayMessageDetails,
				},
				{ triggerTurn: false },
			);
		}
	};

	const schedulePendingMessageFlush = () => {
		if (pendingFlushTimer || pendingActivities.length === 0) {
			return;
		}
		pendingFlushTimer = setTimeout(flushPendingMessages, 0);
	};

	const clearPendingMessages = () => {
		if (pendingFlushTimer) {
			clearTimeout(pendingFlushTimer);
			pendingFlushTimer = undefined;
		}
		pendingActivities.length = 0;
		imagePreviewCache.clear();
	};

	const streamSimple = <TApi extends Api>(model: Model<TApi>, context: Context, streamOptions?: SimpleStreamOptions) => {
		const settings = loadModelSettings(model, options.getCurrentCwd());
		if (
			!settings.enabled
			|| !settings.modelProfile?.effective.enabled
			|| !settings.providerShimActive
		) {
			return model.api === "openai-codex-responses"
				? streamSimpleOpenAICodexResponses(model as Model<"openai-codex-responses">, context, streamOptions)
				: streamSimpleOpenAIResponses(model as Model<"openai-responses">, context, streamOptions);
		}
		return createCodexStream(model, context, streamOptions, {
			getCurrentCwd: options.getCurrentCwd,
			getCurrentTurnId: (sessionId) => sessionId ? activeTurnIds.get(sessionId) : undefined,
			onImageSaved: (savedImage, imageData) => {
				pendingActivities.push({ kind: "image", savedImage, imageData });
			},
		});
	};

	type CodexResponsesApi = "openai-responses" | "openai-codex-responses";
	const registeredProviderApis = new Map<string, CodexResponsesApi>();
	const registerProviderShim = (provider: string, api: CodexResponsesApi): void => {
		if (!provider || registeredProviderApis.get(provider) === api) return;
		pi.registerProvider(provider, { api, streamSimple });
		registeredProviderApis.set(provider, api);
	};
	const ensureProviderShimForModel = (model: Model<Api> | undefined, cwd?: string): void => {
		if (!model) return;
		const settings = loadModelSettings(model, cwd);
		if (
			!settings.enabled
			|| !settings.modelProfile?.effective.enabled
			|| !settings.providerShimActive
		) {
			return;
		}
		if (model.api === "openai-responses" || model.api === "openai-codex-responses") {
			registerProviderShim(model.provider, model.api as CodexResponsesApi);
		}
	};

	// Pi 0.75 dispatches extension streams by API type, while newer Pi versions
	// compose them per provider. Register both built-ins first. A user-defined
	// provider is registered only after Pi supplies an actual selected model, so
	// this extension never creates or overwrites its URL, auth, or model list.
	registerProviderShim("openai-codex", "openai-codex-responses");
	registerProviderShim("openai", "openai-responses");

	pi.on("session_start", async (_event, ctx) => {
		ensureProviderShimForModel(ctx?.model as Model<Api> | undefined, ctx?.cwd);
		activeTurnIds.clear();
		clearPendingMessages();
	});

	pi.on("model_select", async (_event, ctx) => {
		ensureProviderShimForModel(ctx?.model as Model<Api> | undefined, ctx?.cwd);
	});

	pi.on("session_shutdown", async () => {
		if (pendingActivities.length > 0) {
			flushPendingMessages();
		}
		activeTurnIds.clear();
		closeProviderWebSocketSessions();
		clearPendingMessages();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		ensureProviderShimForModel(ctx.model as Model<Api> | undefined, ctx.cwd);
		const sessionId = ctx?.sessionManager?.getSessionId();
		if (!sessionId) return;
		const turnId = createPiTurnId();
		activeTurnIds.set(sessionId, turnId);

		const model = ctx.model;
		const settings = loadModelSettings(model, ctx.cwd);
		if (
			!settings.enabled
			|| !settings.openaiWebSocketPrewarm
			|| settings.openaiTransport === "sse"
			|| !model
			|| !settings.providerShimActive
		) {
			return;
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (
			!auth.ok
			|| !hasCodexRequestAuth({
				modelHeaders: model.headers,
				auth: { apiKey: auth.apiKey, headers: auth.headers },
			})
		) {
			return;
		}

		const profile = resolveCodexRequestProfile(settings.requestProfile);
		const branch = typeof ctx.sessionManager.getBranch === "function" ? ctx.sessionManager.getBranch() : [];
		const sessionContext = convertToLlm(buildSessionContext(branch).messages);
		const activeToolNames = typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [];
		let body = applyFastModeServiceTier(
			buildRequestBody(model, {
				systemPrompt: event.systemPrompt,
				messages: [...sessionContext, {
					role: "user",
					content: [
						{ type: "text", text: event.prompt },
						...(event.images ?? []),
					],
					timestamp: Date.now(),
				}],
				tools: (typeof pi.getAllTools === "function" ? pi.getAllTools() : [])
					.filter((tool) => activeToolNames.includes(tool.name))
					.map((tool) => ({
						name: tool.name,
						description: tool.description,
						parameters: tool.parameters,
					})),
			}, profile, {
				apiKey: auth.apiKey,
				headers: auth.headers,
				sessionId,
				reasoning: thinkingLevelFromUnknown(
					(ctx as { thinkingLevel?: unknown }).thinkingLevel
					?? (typeof pi.getThinkingLevel === "function" ? pi.getThinkingLevel() : undefined),
				),
			}),
			settings,
			model,
		);
		if (settings.nativeProviderTools) {
			const webSearch = settings.modelProfile?.effective.tools.webSearch;
			const rewritten = rewriteNativeOpenAiTools(body, {
				imageModel: settings.imageModel,
				imageGeneration: settings.imageGenerationImplementation ?? false,
				webSearch: settings.webSearchEnabled
					&& webSearch
					? {
							implementation: webSearch.implementation,
							contentTypes: webSearch.contentTypes,
						}
					: false,
			});
			body = rewritten.payload;
		}
		ensureWebSearchDetailsIncluded(body);
		body = withResponsesLiteWebSocketMetadata(body, profile.responsesMode);
		const websocketUrl = resolveResponsesWebSocketUrl(model.baseUrl, { apiKeyMode: settings.apiKeyMode });
		const fallbackKey = webSocketFallbackKey(
			sessionId,
			model,
			websocketUrl,
			settings.modelProfileHash,
		);
		if (settings.openaiTransport === "auto" && fallbackKey && websocketHttpFallbackSessions.has(fallbackKey)) {
			return;
		}
		const headers = applyConfiguredResponsesFeatureHeaders(buildWebSocketHeaders(
			model.headers,
			auth.headers,
			resolveCodexRequestAccountId({
				modelHeaders: model.headers,
				auth: { apiKey: auth.apiKey, headers: auth.headers },
				apiKeyMode: settings.apiKeyMode,
			}),
			auth.apiKey ?? "",
			sessionId,
			sessionId,
		), settings, model);
		const cacheKey = webSocketCacheKey(
			sessionId,
			model,
			websocketUrl,
			headers,
			settings.modelProfileHash,
		);
		if (!cacheKey) return;
		const requestMetadata: WebSocketRequestMetadata = {
			sessionId,
			threadId: sessionId,
			turnId,
		};
		try {
			await preconnectWebSocket(
				websocketUrl,
				headers,
				cacheKey,
				sessionId,
				ctx.signal,
			);
			await prewarmWebSocket({
				url: websocketUrl,
				headers,
				cacheKey,
				body,
				requestMetadata,
				signal: ctx.signal,
			});
		} catch (error) {
			if (
				settings.openaiTransport === "auto"
				&& fallbackKey
				&& error instanceof WebSocketHandshakeError
				&& error.status === 426
			) {
				websocketHttpFallbackSessions.add(fallbackKey);
			}
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		schedulePendingMessageFlush();
	});

	const maybeRegisterAgentSettled = pi as ExtensionAPI & {
		on(event: "agent_settled", handler: (event: { type: "agent_settled" }, ctx: any) => void | Promise<void>): void;
	};
	try {
		maybeRegisterAgentSettled.on("agent_settled", async (_event, ctx) => {
			const sessionId = ctx?.sessionManager?.getSessionId();
			if (sessionId) {
				activeTurnIds.delete(sessionId);
			}
		});
	} catch {
		// Pi versions before agent_settled keep the id until the next
		// before_agent_start overwrites it or the session shuts down.
	}

	pi.registerMessageRenderer<ImageDisplayMessageDetails>(IMAGE_SAVE_DISPLAY_MESSAGE_TYPE, (message, options, theme) => {
		const savedImage = message.details?.savedImages?.[0];
		const textContent = typeof message.content === "string"
			? message.content
			: message.content
					.filter((item) => item.type === "text")
					.map((item) => item.text)
					.join("\n");
		return renderImageGenerationMessage(savedImage, textContent, options, theme, imagePreviewCache);
	});

	pi.registerMessageRenderer<{ searches?: SurfacedWebSearch[] }>(WEB_SEARCH_ACTIVITY_MESSAGE_TYPE, (message, options, theme) => {
		const searches = message.details?.searches ?? [];
		const container = new Container();
		if (searches.length > 0) {
			searches.forEach((search, index) => {
					const completed = search.completed ?? search.status === "completed";
					const header = completed ? "Searched the web" : "Searching the web";
					const detail = webSearchActivityDetail(search);
					const separator = detail ? (completed ? " for " : " ") : "";
					const bullet = themeFg(theme, completed ? "muted" : "accent", glyphs().bullet);
					const lines = [
						`${bullet}${themeFg(theme, "text", themeBold(theme, header))}${themeFg(theme, "dim", `${separator}${detail}`)}`,
					];
					const hosts = webSearchActivityHosts(search);
					if (hosts.length > 0) {
						const shown = hosts.slice(0, 8);
						const hostLine = shown.map((host) => themeFg(theme, "accent", host));
						if (hosts.length > shown.length) {
							hostLine.push(themeFg(theme, "dim", `+${hosts.length - shown.length}`));
						}
						lines.push(`  ${hostLine.join(themeFg(theme, "dim", glyphs().dot))}`);
					}
					container.addChild(new Text(`${index > 0 ? "\n" : ""}${lines.join("\n")}`, 0, 0));
				});
		} else {
			container.addChild(new Text(themeFg(theme, "text", themeBold(theme, buildWebSearchSummaryText(searches))), 0, 0));
		}
		if (options.expanded) {
			const content = typeof message.content === "string"
				? message.content
				: message.content
						.filter((item) => item.type === "text")
						.map((item) => item.text)
						.join("\n");
			container.addChild(new Text(`\n${themeFg(theme, "dim", content)}`, 0, 0));
		}
		return container;
	});

	return {
		getCurrentTurnId(sessionId) {
			return sessionId ? activeTurnIds.get(sessionId) : undefined;
		},
	};
}
