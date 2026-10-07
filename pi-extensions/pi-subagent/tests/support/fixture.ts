import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import {
	createAssistantMessageEventStream, type AssistantMessage, type Context, type Model, type ToolCall,
} from "@earendil-works/pi-ai";
import { ModelRuntime, ModelRegistry, SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SubagentCoordinator } from "../../src/coordinator.ts";
import { DEFAULT_SETTINGS } from "../../src/config.ts";
import type { SubagentSettings } from "../../src/types.ts";

export const usage = {
	input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
export function assistant(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant", content: [{ type: "text", text }], api: "openai-responses",
		provider: "scripted", model: "echo", usage, stopReason, timestamp: Date.now(),
	};
}
export function tempRoot(t: TestContext): string {
	const root = mkdtempSync(join(tmpdir(), "pi-subagent-v2-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}
export function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>(done => { resolve = done; });
	return { promise, resolve };
}
export type Reply = string | ToolCall[] | { error: string };
export function stream(model: Model<any>, reply: Reply | Promise<Reply>, signal?: AbortSignal) {
	const events = createAssistantMessageEventStream();
	let finished = false;
	const finish = (value: Reply) => {
		if (finished) return;
		finished = true;
		signal?.removeEventListener("abort", abort);
		const partial: AssistantMessage = { ...assistant(""), provider: model.provider, model: model.id, api: model.api, stopReason: "pending", content: [] };
		events.push({ type: "start", partial });
		if (signal?.aborted) {
			events.push({ type: "error", reason: "aborted", error: { ...partial, stopReason: "aborted", errorMessage: "aborted" } });
		} else if (typeof value === "object" && !Array.isArray(value)) {
			events.push({ type: "error", reason: "error", error: { ...partial, stopReason: "error", errorMessage: value.error } });
		} else {
			partial.content = typeof value === "string" ? [{ type: "text", text: value }] : value;
			events.push({
				type: "done", reason: typeof value === "string" ? "stop" : "toolUse",
				message: { ...partial, stopReason: typeof value === "string" ? "stop" : "toolUse" },
			});
		}
		events.end();
	};
	const abort = () => finish("");
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted) abort();
	void Promise.resolve(reply).then(finish);
	return events;
}

export async function waitUntil(predicate: () => boolean, timeout = 5000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("condition timed out");
		await new Promise(resolve => setTimeout(resolve, 5));
	}
}

export async function fixture(t: TestContext, options: {
	settings?: Partial<SubagentSettings>;
	reply?: (context: Context, request: number) => Reply | Promise<Reply>;
	extension?: string;
	persistent?: boolean;
	trusted?: boolean;
	modelApi?: Model<any>["api"];
} = {}) {
	const root = tempRoot(t);
	const agentDir = join(root, "agent");
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
	writeFileSync(join(agentDir, "agents", "scout.md"),
		"---\nname: scout\ndescription: Test scout\ntools: read, grep, find, ls\n---\nInspect the task.\n");
	writeFileSync(join(agentDir, "agents", "empty.md"),
		"---\nname: empty\ndescription: No ordinary tools\ntools: none\n---\nAnswer without ordinary tools.\n");
	if (options.extension) {
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		writeFileSync(join(agentDir, "extensions", "test.js"), options.extension);
	}
	const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null });
	const requests: Context[] = [];
	modelRuntime.registerProvider("scripted", {
		baseUrl: "http://scripted.invalid", apiKey: "test", api: options.modelApi ?? "openai-responses",
		models: [{
			id: "echo", name: "Echo", reasoning: false, input: ["text"],
			cost: usage.cost, contextWindow: 100000, maxTokens: 1000,
		}],
		streamSimple: (model, context, opts) => {
			requests.push(structuredClone(context));
			return stream(model, options.reply?.(context, requests.length) ?? `answer ${requests.length}`, opts?.signal);
		},
	});
	const model = modelRuntime.getModel("scripted", "echo");
	assert.ok(model);
	const manager = options.persistent === false ? SessionManager.inMemory(root) : SessionManager.create(root, join(root, "sessions"));
	manager.appendMessage({ role: "user", content: "root question", timestamp: Date.now() });
	manager.appendMessage(assistant("root answer"));
	const events: Array<{ name: string; data: any }> = [];
	const pi = { events: { emit: (name: string, data: unknown) => events.push({ name, data }) } } as unknown as ExtensionAPI;
	const context = {
		cwd: root, sessionManager: manager, modelRegistry: new ModelRegistry(modelRuntime),
		model, thinkingLevel: "off", isProjectTrusted: () => options.trusted ?? true, isIdle: () => true,
		hasPendingMessages: () => false,
	} as unknown as ExtensionContext;
	const settings = { ...DEFAULT_SETTINGS, ...options.settings };
	const packageRoot = resolve(import.meta.dirname, "../..");
	let coordinator = new SubagentCoordinator(pi, packageRoot, settings, agentDir);
	let caller = coordinator.attachRoot(context);
	t.after(async () => { await coordinator.shutdown(); });
	const restart = async () => {
		await coordinator.shutdown();
		coordinator = new SubagentCoordinator(pi, packageRoot, settings, agentDir);
		caller = coordinator.attachRoot(context);
		return { coordinator, caller };
	};
	return {
		root, agentDir, modelRuntime, model, manager, context, pi, settings, packageRoot, requests, events,
		get coordinator() { return coordinator; }, get caller() { return caller; }, restart,
		async idle() { await waitUntil(() => coordinator.activeCount === 0); },
	};
}
