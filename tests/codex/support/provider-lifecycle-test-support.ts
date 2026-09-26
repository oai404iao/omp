import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, Model } from "@earendil-works/pi-ai/compat";

export const responsesModel: Model<"openai-responses"> = {
	api: "openai-responses",
	provider: "openai",
	id: "gpt-5.5",
	name: "Lifecycle test",
	baseUrl: "https://example.test/v1",
	headers: {},
	input: ["text"],
	reasoning: false,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 4096,
};

export function eventContext(model = responsesModel, sessionId = "lifecycle-test"): ExtensionContext {
	return {
		cwd: process.cwd(),
		model,
		getSystemPrompt: () => "",
		sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
		modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }) },
	} as unknown as ExtensionContext;
}

export function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

/** Neutral fixture: shared owner tests must not load another capability's implementation. */
export function createAssistantMessage(model: Model<Api> = responsesModel): AssistantMessage {
	return {
		role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
		usage: {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending", timestamp: Date.now(),
	};
}

export function captureContext(cwd = process.cwd(), signal?: AbortSignal) {
	const events: AssistantMessageEvent[] = [];
	const output = createAssistantMessage(responsesModel);
	const stream = {
		push(event: AssistantMessageEvent) { events.push(structuredClone(event)); },
	} as unknown as AssistantMessageEventStream;
	return { cwd, signal, output, stream, events, requestPrompt: "request prompt" };
}

export async function withCodexSettings(
	settings: Record<string, unknown>,
	run: (directory: string) => Promise<void>,
): Promise<void> {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const directory = mkdtempSync(join(tmpdir(), "omp-provider-lifecycle-"));
	const configDir = join(directory, "extensions", "pi-codex-minimal-tools");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(configDir, "config.json"), JSON.stringify(settings));
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		await run(directory);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(directory, { recursive: true, force: true });
	}
}
