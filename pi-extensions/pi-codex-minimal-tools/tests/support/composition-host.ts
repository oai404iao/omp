import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export async function withCompositionDirectory(run: (directory: string) => Promise<void>) {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const directory = mkdtempSync(join(tmpdir(), "codex-composition-"));
	process.env.PI_CODING_AGENT_DIR = directory;
	try { await run(directory); }
	finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(directory, { recursive: true, force: true });
	}
}

export function writeCompositionConfig(directory: string, settings: object) {
	const path = join(directory, "extensions", "pi-codex-minimal-tools");
	mkdirSync(path, { recursive: true });
	writeFileSync(join(path, "config.json"), JSON.stringify(settings));
}

export function compositionModel(id = "gpt-5.6-sol", provider = "openai") {
	return {
		id, provider, api: provider === "openai-codex" ? "openai-codex-responses" : "openai-responses",
		baseUrl: "https://fixture.invalid/v1", name: id, input: ["text", "image"],
		reasoning: true, contextWindow: 100000, maxTokens: 1000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

export function createCompositionHost(directory: string, bus = new EventEmitter()) {
	const handlers = new Map<string, Function[]>();
	const tools = new Map<string, any>();
	const providers = new Map<string, any>();
	const commands = new Map<string, any>();
	const renderers = new Map<string, any>();
	const messages: any[] = [];
	const subscriptions: Array<() => void> = [];
	let active = ["read", "edit", "write", "bash", "unrelated"];
	let disposed = false;
	const ctx: any = {
		cwd: directory, model: compositionModel(), hasUI: false,
		sessionManager: SessionManager.inMemory(directory),
		modelRegistry: {
			getAll: () => [ctx.model],
			getApiKeyAndHeaders: async () => ({ ok: false, error: "fixture: not logged in" }),
		},
	};
	const add = (map: Map<string, any>, name: string, value: any) => {
		assert.equal(map.has(name), false, `duplicate registration: ${name}`);
		map.set(name, value);
	};
	const api = (): ExtensionAPI => ({
		// Each factory receives a distinct wrapper, as in the real Pi loader.
		events: {
			emit: (name: string, data: unknown) => bus.emit(name, data),
			on: (name: string, handler: (...args: any[]) => void) => {
				bus.on(name, handler);
				const unsubscribe = () => { bus.off(name, handler); };
				subscriptions.push(unsubscribe);
				return unsubscribe;
			},
		},
		on(name: string, handler: Function) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerTool: (tool: any) => add(tools, tool.name, tool),
		registerProvider: (providerOrName: string | { id: string }, value?: any) => {
			if (typeof providerOrName === "string") add(providers, providerOrName, value);
			else add(providers, providerOrName.id, providerOrName);
		},
		registerCommand: (name: string, value: any) => add(commands, name, value),
		registerMessageRenderer: (name: string, value: any) => add(renderers, name, value),
		getAllTools: () => [...tools.values()],
		getActiveTools: () => [...active],
		setActiveTools: (next: string[]) => { active = [...next]; },
		getThinkingLevel: () => "medium",
		appendEntry: (name: string, data: unknown) => ctx.sessionManager.appendCustomEntry(name, data),
		sendMessage(message: unknown) {
			assert.equal(disposed, false, "late use of disposed extension API");
			messages.push(message);
		},
	} as unknown as ExtensionAPI);
	return {
		api, bus, ctx, handlers, tools, providers, commands, renderers, messages,
		active: () => [...active],
		async emit(name: string, event = {}) {
			for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
		},
		dispose() {
			disposed = true;
			for (const unsubscribe of subscriptions) unsubscribe();
			handlers.clear();
		},
	};
}
