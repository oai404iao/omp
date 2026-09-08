import { type ProviderHeaders } from "@earendil-works/pi-ai";
import { type Api, type Model } from "@earendil-works/pi-ai/compat";
import { type CodexRequestProfile } from "../../codex-request-profile.js";
import { codexTurnStateFor, resolveCodexWireIdentity, type CodexRequestIdentity } from "../../codex-wire-identity.js";
import { type ResolvedCodexModelSettings } from "../../model-catalog/runtime.js";
import { isProviderHeaderSuppressed, mergeProviderHeaders, providerHeaderDirective, setProviderDefaultHeader, setProviderGeneratedHeader } from "../../provider-headers.js";
import { CODEX_REMOTE_COMPACTION_V2_FEATURE, OPENAI_BETA_RESPONSES_WEBSOCKETS, X_CODEX_BETA_FEATURES, X_OPENAI_INTERNAL_CODEX_RESPONSES_LITE } from "./constants.js";
import { buildCodexTurnMetadataJson } from "./request-metadata.js";
import { dynamicImport } from "./runtime.js";

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

export function headersToRecord(headers: Headers): Record<string, string> {
	return Object.fromEntries(headers.entries());
}

export function providerHeadersToHeaders(headers: ProviderHeaders): Headers {
	const result = new Headers();
	for (const [name, value] of Object.entries(headers)) {
		if (typeof value === "string") result.set(name, value);
	}
	return result;
}

function buildBaseCodexHeaders(
	modelHeaders: ProviderHeaders | undefined,
	additionalHeaders: ProviderHeaders | undefined,
	accountId: string | undefined,
	token: string,
): Headers {
	const headers = mergeProviderHeaders(modelHeaders, additionalHeaders);
	if (providerHeaderDirective(additionalHeaders, "authorization") === undefined && token) {
		setProviderGeneratedHeader(headers, "Authorization", `Bearer ${token}`);
	}
	if (accountId) setProviderDefaultHeader(headers, "chatgpt-account-id", accountId);
	setProviderDefaultHeader(headers, "originator", "pi");
	setProviderDefaultHeader(
		headers,
		"User-Agent",
		_os ? `pi (${_os.platform()} ${_os.release()}; ${_os.arch()})` : "pi (browser)",
	);
	return headers;
}

/**
 * Resolve the wire identity (UUID v7 session/thread/window) for a pi session
 * and thread. Returns `undefined` when no pi session id is available so
 * session-less requests keep their previous behavior.
 */
function wireIdentityFor(
	sessionId: string | undefined,
	threadId?: string,
): { sessionId: string; threadId: string; windowId: string } | undefined {
	if (!sessionId) return undefined;
	return resolveCodexWireIdentity(sessionId, threadId || sessionId);
}

/** Inject the Codex-compatible identity headers for a session. */
function applyWireIdentityHeaders(
	headers: Headers,
	sessionId: string | undefined,
	threadId: string | undefined,
	requestIdentity?: CodexRequestIdentity,
): void {
	const wire = requestIdentity ?? wireIdentityFor(sessionId, threadId);
	if (!wire) return;
	setProviderGeneratedHeader(headers, "session-id", wire.sessionId);
	setProviderGeneratedHeader(headers, "thread-id", wire.threadId);
	setProviderGeneratedHeader(headers, "x-codex-window-id", wire.windowId);
	setProviderGeneratedHeader(headers, "x-client-request-id", wire.threadId);
	const turnState = requestIdentity?.turnState
		?? (sessionId ? codexTurnStateFor(sessionId) : undefined);
	if (turnState) {
		setProviderGeneratedHeader(headers, "x-codex-turn-state", turnState);
	}
	if (requestIdentity?.parentThreadId) {
		setProviderGeneratedHeader(
			headers,
			"x-codex-parent-thread-id",
			requestIdentity.parentThreadId,
		);
	}
	if (requestIdentity?.subagentKind) {
		setProviderGeneratedHeader(
			headers,
			"x-openai-subagent",
			requestIdentity.subagentKind,
		);
	}
	if (requestIdentity) {
		setProviderGeneratedHeader(
			headers,
			"x-codex-turn-metadata",
			buildCodexTurnMetadataJson(requestIdentity),
		);
	}
}

/** Codex identity headers for an SSE request (exported for tests). */
export function buildSSEHeaders(
	modelHeaders: ProviderHeaders | undefined,
	additionalHeaders: ProviderHeaders | undefined,
	accountId: string | undefined,
	token: string,
	sessionId: string | undefined,
	profile: CodexRequestProfile,
	threadId?: string,
	requestIdentity?: CodexRequestIdentity,
): Headers {
	const headers = buildBaseCodexHeaders(modelHeaders, additionalHeaders, accountId, token);
	setProviderDefaultHeader(headers, "OpenAI-Beta", "responses=experimental");
	setProviderDefaultHeader(headers, "accept", "text/event-stream");
	setProviderDefaultHeader(headers, "content-type", "application/json");
	if (profile.responsesMode === "lite") {
		setProviderDefaultHeader(headers, X_OPENAI_INTERNAL_CODEX_RESPONSES_LITE, "true");
	}

	applyWireIdentityHeaders(headers, sessionId, threadId, requestIdentity);

	return headers;
}

function appendCommaSeparatedHeader(headers: Headers, name: string, value: string): void {
	if (isProviderHeaderSuppressed(headers, name)) return;
	const values = (headers.get(name) ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	if (!values.includes(value)) headers.set(name, [...values, value].join(","));
}

export function applyConfiguredResponsesFeatureHeaders(
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
	modelHeaders: ProviderHeaders | undefined,
	additionalHeaders: ProviderHeaders | undefined,
	accountId: string | undefined,
	token: string,
	sessionId: string,
	threadId = sessionId,
	requestIdentity?: CodexRequestIdentity,
): Headers {
	const headers = buildBaseCodexHeaders(modelHeaders, additionalHeaders, accountId, token);
	headers.delete("accept");
	headers.delete("content-type");
	headers.delete("OpenAI-Beta");
	headers.delete("openai-beta");
	setProviderDefaultHeader(headers, "OpenAI-Beta", OPENAI_BETA_RESPONSES_WEBSOCKETS);
	setProviderDefaultHeader(headers, "x-client-request-id", threadId);
	setProviderDefaultHeader(headers, "session-id", sessionId);
	setProviderDefaultHeader(headers, "thread-id", threadId);
	const wire = requestIdentity ?? wireIdentityFor(sessionId, threadId);
	if (wire) {
		setProviderGeneratedHeader(headers, "session-id", wire.sessionId);
		setProviderGeneratedHeader(headers, "thread-id", wire.threadId);
		setProviderGeneratedHeader(headers, "x-codex-window-id", wire.windowId);
		setProviderGeneratedHeader(headers, "x-client-request-id", wire.threadId);
	}
	if (requestIdentity?.parentThreadId) {
		setProviderGeneratedHeader(
			headers,
			"x-codex-parent-thread-id",
			requestIdentity.parentThreadId,
		);
	}
	if (requestIdentity?.subagentKind) {
		setProviderGeneratedHeader(
			headers,
			"x-openai-subagent",
			requestIdentity.subagentKind,
		);
	}
	if (requestIdentity) {
		setProviderGeneratedHeader(
			headers,
			"x-codex-turn-metadata",
			buildCodexTurnMetadataJson(requestIdentity),
		);
	}
	return headers;
}

export function buildJsonHeaders(
	modelHeaders: ProviderHeaders | undefined,
	additionalHeaders: ProviderHeaders | undefined,
	accountId: string | undefined,
	apiKey: string,
	sessionId?: string,
	requestIdentity?: CodexRequestIdentity,
): Headers {
	const headers = buildBaseCodexHeaders(modelHeaders, additionalHeaders, accountId, apiKey);
	setProviderDefaultHeader(headers, "accept", "application/json");
	setProviderDefaultHeader(headers, "content-type", "application/json");
	applyWireIdentityHeaders(
		headers,
		sessionId,
		requestIdentity?.threadId ?? sessionId,
		requestIdentity,
	);
	return headers;
}
