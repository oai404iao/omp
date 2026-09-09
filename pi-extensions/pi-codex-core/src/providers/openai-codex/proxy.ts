import { ProxyAgent, type Dispatcher } from "undici";

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

export async function proxyDispatcherForUrl(rawUrl: string): Promise<Dispatcher | undefined> {
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
