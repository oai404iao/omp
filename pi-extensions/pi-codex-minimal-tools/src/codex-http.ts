const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

export interface CodexRequestAuth {
	apiKey?: string;
	headers?: Record<string, string>;
}

function bearerToken(headers: Headers): string | undefined {
	const authorization = headers.get("authorization");
	const match = authorization ? /^Bearer\s+(.+)$/i.exec(authorization.trim()) : null;
	return match?.[1]?.trim() || undefined;
}

function authHeaders(options: {
	modelHeaders?: Record<string, string>;
	auth: CodexRequestAuth;
}): Headers {
	const headers = new Headers(options.modelHeaders);
	for (const [name, value] of Object.entries(options.auth.headers ?? {})) headers.set(name, value);
	return headers;
}

function explicitAuthorization(headers: Record<string, string> | undefined): string | undefined {
	const entry = Object.entries(headers ?? {}).find(
		([name, value]) => name.toLowerCase() === "authorization" && value.trim(),
	);
	return entry?.[1];
}

export function hasCodexRequestAuth(options: {
	modelHeaders?: Record<string, string>;
	auth: CodexRequestAuth;
}): boolean {
	if (options.auth.apiKey) return true;
	const headers = authHeaders(options);
	return ["authorization", "api-key", "x-api-key", "x-openai-actor-authorization"]
		.some((name) => Boolean(headers.get(name)?.trim()));
}

export function resolveCodexRequestAccountId(options: {
	modelHeaders?: Record<string, string>;
	auth: CodexRequestAuth;
	apiKeyMode: boolean;
}): string | undefined {
	if (options.apiKeyMode) return undefined;
	const headers = authHeaders(options);
	if (
		headers.get("chatgpt-account-id")?.trim()
		|| headers.get("x-openai-actor-authorization")?.trim()
	) {
		return undefined;
	}
	const explicit = explicitAuthorization(options.auth.headers);
	const token = explicit
		? bearerToken(new Headers({ authorization: explicit }))
		: options.auth.apiKey ?? bearerToken(new Headers(options.modelHeaders));
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
	modelHeaders?: Record<string, string>;
	auth: CodexRequestAuth;
	apiKeyMode: boolean;
	extraHeaders?: Record<string, string>;
}): Headers {
	const headers = new Headers(options.modelHeaders);
	for (const [name, value] of Object.entries(options.auth.headers ?? {})) headers.set(name, value);
	for (const [name, value] of Object.entries(options.extraHeaders ?? {})) headers.set(name, value);
	const hasExplicitAuthorization = Boolean(explicitAuthorization(options.auth.headers));
	if (!hasExplicitAuthorization && options.auth.apiKey) {
		headers.set("Authorization", `Bearer ${options.auth.apiKey}`);
	}
	if (
		!options.apiKeyMode
		&& !headers.has("chatgpt-account-id")
		&& !headers.has("x-openai-actor-authorization")
	) {
		const accountId = resolveCodexRequestAccountId(options);
		if (accountId) headers.set("chatgpt-account-id", accountId);
	}
	if (!headers.has("originator")) headers.set("originator", "pi");
	headers.set("accept", "application/json");
	headers.set("content-type", "application/json");
	return headers;
}
