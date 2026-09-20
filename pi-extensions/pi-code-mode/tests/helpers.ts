import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
	createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import codeMode from "../src/extension.ts";

export async function scratch(prefix: string): Promise<string> {
	const root = join(homedir(), ".local/state/agents/tmp");
	await mkdir(root, { recursive: true, mode: 0o700 });
	return mkdtemp(join(root, `code-mode-s1-${prefix}-`));
}

export async function piSession(t: TestContext, options: {
	cwd?: string; host?: string; grant?: boolean; api?: string; factory?: ExtensionFactory;
	write?: boolean; process?: boolean; tools?: string;
	visibility?: string; factoryFirst?: boolean; activeTools?: string[];
	protocol?: string; grammar?: boolean; factories?: ExtensionFactory[];
} = {}) {
	const cwd = options.cwd ?? await scratch("pi");
	const agentDir = join(cwd, "agent");
	await mkdir(agentDir, { recursive: true });
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const loader = new DefaultResourceLoader({
		cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noThemes: true,
		noPromptTemplates: true, noContextFiles: true,
		additionalExtensionPaths: options.factoryFirst ? [] : [fileURLToPath(new URL("../index.ts", import.meta.url))],
		extensionFactories: options.factoryFirst ? [...(options.factories ?? [options.factory!]), codeMode] : options.factories ?? (options.factory ? [options.factory] : []),
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const loaded = loader.getExtensions();
	if (options.host) loaded.runtime.flagValues.set("code-mode-host", options.host);
	if (options.grant) loaded.runtime.flagValues.set("code-mode-read-root", cwd);
	if (options.write) loaded.runtime.flagValues.set("code-mode-write", true);
	if (options.process) loaded.runtime.flagValues.set("code-mode-process", true);
	if (options.tools) loaded.runtime.flagValues.set("code-mode-tools", options.tools);
	if (options.visibility) loaded.runtime.flagValues.set("code-mode-visibility", options.visibility);
	if (options.protocol) loaded.runtime.flagValues.set("code-mode-protocol", options.protocol);
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(), modelsPath: null,
		modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false,
	});
	modelRuntime.registerProvider("s1-fixture", {
		api: options.api ?? "openai-completions", apiKey: "fixture-not-real",
		baseUrl: "https://s1-fixture.invalid",
		models: [{
			id: "s1", name: "S1 fixture", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 2000,
			...(options.grammar === undefined ? {} : { compat: { supportsOpenAIGrammarTools: options.grammar } }),
		}],
	});
	const errors: string[] = [];
	const { session } = await createAgentSession({
		cwd, agentDir, modelRuntime, model: modelRuntime.getModel("s1-fixture", "s1"),
		resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), settingsManager, thinkingLevel: "off",
		tools: options.activeTools,
	});
	await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.error) });
	t.after(async () => {
		await session.abort();
		await session.prompt("/code-mode off");
		session.dispose();
		loaded.runtime.invalidate();
	});
	return { cwd, session, loader, errors, modelRuntime };
}
