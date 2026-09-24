import { ProxyAgent, type Dispatcher } from "undici";
import type { ProviderEnv } from "@earendil-works/pi-ai";

function envFirst(names: string[], env?: ProviderEnv): string | undefined {
	for (const source of [env, typeof process === "undefined" ? undefined : process.env]) {
		for (const name of names) {
			const value = source?.[name];
			if (value?.trim()) return value.trim();
		}
		if (source === env && names.some((name) => Object.hasOwn(env ?? {}, name))) return undefined;
	}
	return undefined;
}

function noProxyMatches(url: URL, noProxy: string | undefined): boolean {
	if (!noProxy) return false;
	const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	const port = url.port || (url.protocol === "https:" || url.protocol === "wss:" ? "443" : "80");
	for (const rawPart of noProxy.split(/[,\s]+/)) {
		const part = rawPart.trim().toLowerCase();
		if (!part) continue;
		if (part === "*") return true;
		const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(part);
		if (match?.[2] && match[2] !== port) continue;
		const normalized = (match?.[1] ?? part).replace(/^\[|\]$/g, "").replace(/^\*?\./, "");
		if (host === normalized || host.endsWith(`.${normalized}`)) return true;
	}
	return false;
}

export function proxyForWebSocketUrl(rawUrl: string, env?: ProviderEnv): string | undefined {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return undefined;
	}
	const noProxy = envFirst(["NO_PROXY", "no_proxy"], env);
	if (noProxyMatches(url, noProxy)) return undefined;
	if (url.protocol === "wss:" || url.protocol === "https:") {
		return envFirst(["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"], env);
	}
	if (url.protocol === "ws:" || url.protocol === "http:") {
		return envFirst(["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"], env);
	}
	return undefined;
}

export async function proxyDispatcherForUrl(rawUrl: string, env?: ProviderEnv): Promise<Dispatcher | undefined> {
	const proxy = proxyForWebSocketUrl(rawUrl, env);
	if (!proxy) return undefined;
	return new ProxyAgent(proxy);
}

export async function webSocketOptionsForUrl(url: string, headers: Record<string, string>, env?: ProviderEnv): Promise<{
	headers: Record<string, string>;
	dispatcher?: Dispatcher;
}> {
	const dispatcher = await proxyDispatcherForUrl(url, env);
	return dispatcher ? { headers, dispatcher } : { headers };
}
