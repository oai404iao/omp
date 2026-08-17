import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const root = mkdtempSync(join(tmpdir(), "pi-subagent-smoke-"));

after(() => {
	rmSync(root, { recursive: true, force: true });
});

test("extension loads and registers its model-facing surface", async () => {
	const cwd = resolve(import.meta.dirname, "..");
	const agentDir = join(root, "agent");
	const settingsManager = SettingsManager.inMemory({});
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		additionalExtensionPaths: [join(cwd, "src", "index.ts")],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);

	const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null });
	const { session } = await createAgentSession({
		cwd,
		resourceLoader: loader,
		modelRuntime,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
	});
	try {
		await session.bindExtensions({ mode: "print" });
		const names = new Set(session.getAllTools().map((tool) => tool.name));
		for (const expected of [
			"subagent",
			"subagent_fork",
			"send_message",
			"interrupt_agent",
			"list_agents",
		]) {
			assert.equal(names.has(expected), true, `${expected} should be registered`);
		}
	} finally {
		session.dispose();
	}
});
