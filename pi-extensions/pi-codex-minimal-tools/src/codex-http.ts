import type { ProviderHeaders } from "@earendil-works/pi-ai";
import {
	isProviderHeaderSuppressed,
	mergeProviderHeaders,
	providerHeaderDirective,
	setProviderDefaultHeader,
	setProviderGeneratedHeader,
} from "./provider-headers.js";

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

export interface CodexRequestAuth {
	apiKey?: string;
	headers?: ProviderHeaders;
}

function bearerToken(headers: Headers): string | undefined {
	const authorization = headers.get("authorization");
	const match = authorization ? /^Bearer\s+(.+)$/i.exec(authorization.trim()) : null;
	return match?.[1]?.trim() || undefined;
}

function authHeaders(options: {
	modelHeaders?: ProviderHeaders;
	auth: CodexRequestAuth;
}): Headers {
	return mergeProviderHeaders(options.modelHeaders, options.auth.headers);
}

export function hasCodexRequestAuth(options: {
	modelHeaders?: ProviderHeaders;
	auth: CodexRequestAuth;
}): boolean {
	const headers = authHeaders(options);
	if (
		options.auth.apiKey
		&& providerHeaderDirective(options.auth.headers, "authorization") === undefined
		&& !isProviderHeaderSuppressed(headers, "authorization")
	) {
		return true;
	}
	return ["authorization", "api-key", "x-api-key", "x-openai-actor-authorization"]
		.some((name) => Boolean(headers.get(name)?.trim()));
}

export function resolveCodexRequestAccountId(options: {
	modelHeaders?: ProviderHeaders;
	auth: CodexRequestAuth;
	apiKeyMode: boolean;
}): string | undefined {
	if (options.apiKeyMode) return undefined;
	const headers = authHeaders(options);
	if (
		headers.get("chatgpt-account-id")?.trim()
		|| headers.get("x-openai-actor-authorization")?.trim()
		|| isProviderHeaderSuppressed(headers, "chatgpt-account-id")
	) {
		return undefined;
	}
	const requestAuthorization = providerHeaderDirective(options.auth.headers, "authorization");
	const token = requestAuthorization !== undefined
		? typeof requestAuthorization === "string" && requestAuthorization.trim()
			? bearerToken(new Headers({ authorization: requestAuthorization }))
			: undefined
		: isProviderHeaderSuppressed(headers, "authorization")
			? undefined
			: options.auth.apiKey ?? bearerToken(headers);
	return token ? extractCodexAccountId(token) : undefined;
}

function responseEndpoint(baseUrl: string | undefined, apiKeyMode: boolean): string {
	const raw = baseUrl?.trim() || (apiKeyMode ? DEFAULT_OPENAI_BASE_URL : DEFAULT_CODEX_BASE_URL);
	const normalized = raw.replace(/\/+$/, "");
	if (apiKeyMode) {
		if (normalized.endsWith("/responses")) return normalized;
		return `${normalized}/responses`;
	}
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

export function resolveCodexApiEndpoint(
	baseUrl: string | undefined,
	apiKeyMode: boolean,
	path: string,
): string {
	const root = responseEndpoint(baseUrl, apiKeyMode).replace(/\/responses$/, "");
	return `${root}/${path.replace(/^\/+/, "")}`;
}

export function extractCodexAccountId(token: string): string {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) throw new Error("Invalid token");
		const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64").toString("utf8"));
		const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
		if (typeof accountId !== "string" || !accountId) throw new Error("No account ID in token");
		return accountId;
	} catch {
		throw new Error("Failed to extract accountId from Codex OAuth token");
	}
}

export function buildCodexJsonHeaders(options: {
	modelHeaders?: ProviderHeaders;
	auth: CodexRequestAuth;
	apiKeyMode: boolean;
	extraHeaders?: Record<string, string>;
}): Headers {
	const headers = authHeaders(options);
	for (const [name, value] of Object.entries(options.extraHeaders ?? {})) {
		setProviderGeneratedHeader(headers, name, value);
	}
	const requestAuthorization = providerHeaderDirective(options.auth.headers, "authorization");
	if (requestAuthorization === undefined && options.auth.apiKey) {
		setProviderGeneratedHeader(headers, "Authorization", `Bearer ${options.auth.apiKey}`);
	}
	if (
		!options.apiKeyMode
		&& !headers.has("chatgpt-account-id")
		&& !headers.has("x-openai-actor-authorization")
	) {
		const accountId = resolveCodexRequestAccountId(options);
		if (accountId) setProviderDefaultHeader(headers, "chatgpt-account-id", accountId);
	}
	setProviderDefaultHeader(headers, "originator", "pi");
	setProviderDefaultHeader(headers, "accept", "application/json");
	setProviderDefaultHeader(headers, "content-type", "application/json");
	return headers;
}
