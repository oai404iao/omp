import assert from "node:assert/strict";
import { registerOpenAIResponsesProviders } from "../../src/provider-shim.js";

export function codexJwt(): string {
	const payload = Buffer.from(JSON.stringify({
		"https://api.openai.com/auth": { chatgpt_account_id: "acct_test" },
	})).toString("base64");
	return `header.${payload}.signature`;
}

export function createProviderHarness(options?: {
	snapshotTools?: boolean;
	register?: typeof registerOpenAIResponsesProviders;
	cwd?: string;
}) {
	const providers: Record<string, any> = {};
	const handlers: Record<string, Array<(event: any, ctx?: any) => Promise<void> | void>> = {};
	const messages: any[] = [];
	const renderers: Record<string, Function> = {};
	const pi = {
		registerProvider(providerOrName: string | { id: string }, value?: any) {
			if (typeof providerOrName === "string") providers[providerOrName] = value;
			else providers[providerOrName.id] = providerOrName;
		},
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
	(options?.register ?? registerOpenAIResponsesProviders)(pi as any, { getCurrentCwd: () => options?.cwd ?? process.cwd() });
	assert.ok(providers["openai-codex"]);
	assert.ok(providers.openai);
	return { providers, handlers, messages, renderers };
}
