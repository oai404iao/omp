import { endpointDeclares, endpointKey, type EndpointConfig, type EndpointCapability, type EndpointIdentity } from "./endpoint-config.js";

interface SessionState {
	blocked: Map<string, Set<EndpointCapability>>;
	resolved: Map<string, { configuredBaseUrl?: string; baseUrl?: string }>;
	listeners: Set<(message?: string) => void>;
}
const STATE = Symbol.for("@oai404iao/pi-codex/endpoint-state/v1");
function sessions(): Map<string, SessionState> {
	const global = globalThis as typeof globalThis & { [STATE]?: Map<string, SessionState> };
	return global[STATE] ??= new Map();
}
function session(id: string): SessionState {
	let state = sessions().get(id);
	if (!state) sessions().set(id, state = { blocked: new Map(), resolved: new Map(), listeners: new Set() });
	return state;
}
export function watchEndpointFailures(id: string, listener: (message?: string) => void): () => void {
	session(id).listeners.add(listener);
	return () => { sessions().get(id)?.listeners.delete(listener); };
}
export function clearEndpointFailures(id: string): void { sessions().delete(id); }
function modelKey(model: EndpointIdentity): string { return JSON.stringify([model.provider, model.id]); }

export function rememberResolvedEndpoint(configured: EndpointIdentity, resolved: EndpointIdentity, id?: string): void {
	const state = id ? sessions().get(id) : undefined;
	if (!state) return;
	const key = modelKey(configured);
	const previous = state.resolved.get(key);
	if (previous?.configuredBaseUrl === configured.baseUrl && previous?.baseUrl === resolved.baseUrl) return;
	state.resolved.set(key, { configuredBaseUrl: configured.baseUrl, baseUrl: resolved.baseUrl });
	for (const listener of state.listeners) listener();
}

/** Declaration projection must not assume a catalog URL is the authenticated request URL. */
export function knownEndpointModel<T extends EndpointIdentity>(model: T, id?: string): T & EndpointIdentity {
	const known = id ? sessions().get(id)?.resolved.get(modelKey(model)) : undefined;
	return { ...model, baseUrl: known?.configuredBaseUrl === model.baseUrl ? known?.baseUrl : undefined };
}
export function endpointWasRejected(model: EndpointIdentity, id: string | undefined, capability: EndpointCapability): boolean {
	const key = endpointKey(model);
	return Boolean(id && key && sessions().get(id)?.blocked.get(key)?.has(capability));
}

export function requireEndpointCapability(
	entries: readonly EndpointConfig[], model: EndpointIdentity, id: string | undefined, capability: EndpointCapability,
): void {
	if (!endpointDeclares(entries, model, capability) || endpointWasRejected(model, id, capability)) {
		throw new Error(`${capability} is disabled for this endpoint. Review endpoint_config; no implementation fallback was selected.`);
	}
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

/** Only explicit protocol rejection disables capabilities; ordinary HTTP/auth failures do not. */
export function unsupportedEndpointCapabilities(candidates: readonly EndpointCapability[], failure: unknown): EndpointCapability[] {
	let error = record(failure);
	const status = error.status;
	if (typeof status === "number" && ![400, 404, 422, 501].includes(status)) return [];
	if (typeof error.responseBody === "string") {
		try { error = record(JSON.parse(error.responseBody)); } catch { return []; }
	}
	error = Object.keys(record(error.error)).length ? record(error.error) : error;
	const code = typeof error.code === "string" ? error.code : "";
	const message = typeof error.message === "string" ? error.message : "";
	const param = typeof error.param === "string" ? error.param : "";
	if (code === "unsupported_parameter" && param !== "compaction_trigger") return [];
	const explicitCode = /^(unsupported_(tool|feature|parameter|endpoint)|unknown_tool|not_implemented)$/.test(code);
	if (!explicitCode && !(typeof status === "number" && /\b(not supported|unsupported|unknown tool)\b/i.test(message))) return [];
	const text = `${param} ${message}`;
	const aliases: Record<EndpointCapability, RegExp> = {
		"webSearch.hosted": /\bweb_search\b/,
		"webSearch.standalone": /alpha\/search|\bweb\.run\b/,
		"imageGeneration.hosted": /\bimage_generation\b/,
		"imageGeneration.standalone": /images\/(generations|edits)|\bimage_gen\b/,
		"compaction.responses": /\bcompaction_trigger\b|\bremote_compaction_v2\b/,
		"compaction.responses-compact": /responses\/compact/,
	};
	return candidates.filter(capability => aliases[capability].test(text));
}

export function reportEndpointFailure(
	model: EndpointIdentity, id: string | undefined, candidates: readonly EndpointCapability[], failure: unknown,
): boolean {
	const rejected = unsupportedEndpointCapabilities(candidates, failure);
	const key = endpointKey(model);
	const state = id ? sessions().get(id) : undefined;
	if (!state || !key) return rejected.length > 0;
	for (const capability of rejected) {
		const blocked = state.blocked.get(key) ?? new Set<EndpointCapability>();
		if (blocked.has(capability)) continue;
		blocked.add(capability);
		state.blocked.set(key, blocked);
		const notice = `${capability} was explicitly rejected by the endpoint and is disabled for this session. Review endpoint_config; no provider or implementation was switched.`;
		for (const listener of state.listeners) listener(notice);
	}
	return rejected.length > 0;
}

export async function checkEndpointResponse(
	response: Response, model: EndpointIdentity, id: string | undefined, candidates: readonly EndpointCapability[],
	signal?: AbortSignal,
): Promise<void> {
	if (response.ok) return;
	const responseBody = await response.text();
	signal?.throwIfAborted();
	reportEndpointFailure(model, id, candidates, { status: response.status, responseBody });
	throw Object.assign(new Error(`HTTP ${response.status}: ${responseBody}`), { status: response.status, responseBody });
}
