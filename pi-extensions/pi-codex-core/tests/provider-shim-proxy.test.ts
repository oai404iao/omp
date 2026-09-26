import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { proxyForWebSocketUrl, webSocketOptionsForUrl } from "@oai404iao/pi-codex-core/internal/providers/openai-codex/proxy";
import { webSocketCacheKey, webSocketFallbackKey } from "@oai404iao/pi-codex-core/internal/providers/openai-codex/cache-key";

const originalEnv = {
	HTTP_PROXY: process.env.HTTP_PROXY,
	http_proxy: process.env.http_proxy,
	HTTPS_PROXY: process.env.HTTPS_PROXY,
	https_proxy: process.env.https_proxy,
	ALL_PROXY: process.env.ALL_PROXY,
	all_proxy: process.env.all_proxy,
	NO_PROXY: process.env.NO_PROXY,
	no_proxy: process.env.no_proxy,
};

afterEach(() => {
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

test("proxyForWebSocketUrl maps websocket transports through proxy envs", () => {
	process.env.HTTPS_PROXY = "http://proxy.example:8080";
	process.env.HTTP_PROXY = "http://plain-proxy.example:8080";
	delete process.env.NO_PROXY;
	delete process.env.no_proxy;
	assert.equal(proxyForWebSocketUrl("wss://chatgpt.com/backend-api/codex/responses"), "http://proxy.example:8080");
	assert.equal(proxyForWebSocketUrl("ws://localhost:8080/socket"), "http://plain-proxy.example:8080");
});

test("proxyForWebSocketUrl falls back to ALL_PROXY", () => {
	delete process.env.HTTPS_PROXY;
	delete process.env.https_proxy;
	delete process.env.HTTP_PROXY;
	delete process.env.http_proxy;
	process.env.ALL_PROXY = "socks5://proxy.example:1080";
	delete process.env.NO_PROXY;
	delete process.env.no_proxy;
	assert.equal(proxyForWebSocketUrl("wss://chatgpt.com/backend-api/codex/responses"), "socks5://proxy.example:1080");
});

test("webSocketOptionsForUrl exposes proxy configuration for compatibility callers", async () => {
	process.env.HTTPS_PROXY = "http://proxy.example:8080";
	delete process.env.NO_PROXY;
	const options = await webSocketOptionsForUrl("wss://chatgpt.com/backend-api/codex/responses", { Authorization: "Bearer token" });
	assert.equal(options.headers.Authorization, "Bearer token");
	assert.equal("proxy" in options, false);
	assert.ok(options.dispatcher);
});

test("proxyForWebSocketUrl honors NO_PROXY host entries", () => {
	process.env.HTTPS_PROXY = "http://proxy.example:8080";
	process.env.NO_PROXY = ".chatgpt.com,localhost";
	assert.equal(proxyForWebSocketUrl("wss://chatgpt.com/backend-api/codex/responses"), undefined);
	assert.equal(proxyForWebSocketUrl("wss://api.chatgpt.com/backend-api/codex/responses"), undefined);
});

test("provider proxy environment overrides ambient values, with port/IPv6 NO_PROXY", async () => {
	process.env.HTTPS_PROXY = "http://ambient.invalid:8080";
	delete process.env.NO_PROXY;
	delete process.env.no_proxy;
	const env = { https_proxy: "http://provider.invalid:8080", NO_PROXY: ".example.test:443,[::1]:8080" };
	assert.equal(proxyForWebSocketUrl("wss://api.example.test/path", env), undefined);
	assert.equal(proxyForWebSocketUrl("wss://api.example.test:8443/path", env), env.https_proxy);
	assert.equal(proxyForWebSocketUrl("ws://[::1]:8080/path", env), undefined);
	assert.equal(proxyForWebSocketUrl("wss://remote.invalid", { ...env, NO_PROXY: "*" }), undefined);
	assert.equal(proxyForWebSocketUrl("wss://remote.invalid", env), env.https_proxy);
	const options = await webSocketOptionsForUrl("wss://remote.invalid", {}, env);
	assert.ok(options.dispatcher);
	await options.dispatcher.close();
});

test("socket reuse and fallback are separated by effective proxy route, not unrelated env", () => {
	const model = { provider: "openai", api: "openai-responses", id: "gpt-5.5" } as any;
	const url = "wss://remote.invalid";
	const first = { HTTPS_PROXY: "http://first.invalid:8080", NO_PROXY: "unrelated.invalid" };
	const second = { ...first, HTTPS_PROXY: "http://second.invalid:8080" };
	const key = (env: Record<string, string>) => webSocketCacheKey("session", model, url, new Headers(), "profile", env);
	assert.notEqual(key(first), key(second));
	assert.equal(key(first), key({ ...first, UNRELATED: "value" }));
	assert.notEqual(key(first), key({ ...first, NO_PROXY: "*" }));
	assert.notEqual(webSocketFallbackKey("session", model, url, "profile", first), webSocketFallbackKey("session", model, url, "profile", second));
});

test("explicit empty provider overrides clear ambient proxy and NO_PROXY settings", () => {
	process.env.HTTPS_PROXY = "http://ambient.invalid:8080";
	process.env.NO_PROXY = "*";
	const url = "wss://remote.invalid";
	const env = { HTTPS_PROXY: "http://provider.invalid:8080", NO_PROXY: "" };
	assert.equal(proxyForWebSocketUrl(url, env), env.HTTPS_PROXY);
	assert.equal(proxyForWebSocketUrl(url, { HTTPS_PROXY: "", NO_PROXY: "" }), undefined);
	const model = { provider: "openai", api: "openai-responses", id: "gpt-5.5" } as any;
	assert.notEqual(
		webSocketCacheKey("session", model, url, new Headers()),
		webSocketCacheKey("session", model, url, new Headers(), undefined, env),
	);
});
