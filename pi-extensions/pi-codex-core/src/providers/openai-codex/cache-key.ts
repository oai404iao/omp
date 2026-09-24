import { type Api, type Model } from "@earendil-works/pi-ai/compat";
import type { ProviderEnv } from "@earendil-works/pi-ai";
import { proxyForWebSocketUrl } from "./proxy.js";

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

function webSocketHeaderIdentity(headers: Headers): string {
	const requestScoped = new Set([
		"x-codex-turn-metadata",
		"x-codex-turn-state",
		"x-codex-window-id",
	]);
	return shortHash(
		[...headers.entries()]
			.filter(([name]) => !requestScoped.has(name.toLowerCase()))
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([name, value]) => `${name}:${value}`)
			.join("\n"),
	);
}

export function webSocketCacheKey(
	sessionId: string | undefined,
	model: Model<Api>,
	url: string,
	headers: Headers,
	profileHash?: string,
	env?: ProviderEnv,
): string | undefined {
	return sessionId
		? `${sessionId}\n${model.provider}\n${model.api}\n${model.id}\n${url}\n${profileHash ?? "no-profile"}\n${webSocketHeaderIdentity(headers)}\n${shortHash(proxyForWebSocketUrl(url, env) ?? "direct")}`
		: undefined;
}

export function webSocketFallbackKey(
	sessionId: string | undefined,
	model: Model<Api>,
	url: string,
	profileHash?: string,
	env?: ProviderEnv,
): string | undefined {
	return sessionId
		? `${sessionId}\n${model.provider}\n${model.api}\n${model.id}\n${url}\n${profileHash ?? "no-profile"}\n${shortHash(proxyForWebSocketUrl(url, env) ?? "direct")}`
		: undefined;
}
