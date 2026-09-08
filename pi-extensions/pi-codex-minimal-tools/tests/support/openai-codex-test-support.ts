import assert from "node:assert/strict";
import { registerOpenAIResponsesProviders } from "../../src/provider-shim.js";

export function codexJwt(): string {
	const payload = Buffer.from(JSON.stringify({
		"https://api.openai.com/auth": { chatgpt_account_id: "acct_test" },
	})).toString("base64");
	return `header.${payload}.signature`;
}

export function createProviderHarness(options?: { snapshotTools?: boolean }) {
	const providers: Record<string, any> = {};
	const handlers: Record<string, Array<(event: any, ctx?: any) => Promise<void> | void>> = {};
	const messages: any[] = [];
	const renderers: Record<string, Function> = {};
	const pi = {
		registerProvider(name: string, value: any) { providers[name] = value; },
		on(name: string, handler: (event: any, ctx: any) => Promise<void> | void) {
			(handlers[name] ??= []).push(handler);
		},
		registerMessageRenderer(type: string, renderer: Function) { renderers[type] = renderer; },
		sendMessage(message: any, options: any) { messages.push({ message, options }); },
		...(options?.snapshotTools ? {
			getActiveTools: () => [],
			getAllTools: () => [],
			getThinkingLevel: () => "medium",
		} : {}),
	};
	registerOpenAIResponsesProviders(pi as any, { getCurrentCwd: () => process.cwd() });
	assert.ok(providers["openai-codex"]);
	assert.ok(providers.openai);
	return { providers, handlers, messages, renderers };
}
