import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fixture, tempRoot } from "./support/fixture.ts";

const subprocessEnv = { ...process.env };
delete subprocessEnv.NODE_PATH;

for (const count of [2, 8]) {
	test(`real Pi jiti cold graph admits ${count} parallel children, cold resume and reload`, t => {
		const result = spawnSync(process.execPath, [resolve(import.meta.dirname, "support/cold-loader.mjs"), tempRoot(t), String(count)],
			{ encoding: "utf8", timeout: 90000, env: subprocessEnv });
		assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
	});
}

test("jiti resolution distinguishes absent packages from damaged installed integrations", async t => {
	const sdkRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
	const jitiPath = sdkRequire.resolve("jiti");
	const cases: Array<{ name: string; manifest?: unknown; entry?: string; expected: string }> = [
		{ name: "absent", expected: "absent" },
		{ name: "directory-only", expected: "failed" },
		{ name: "missing-subpath", manifest: { exports: { ".": "./index.js" } }, expected: "failed" },
		{ name: "missing-entry", manifest: { exports: { "./subagent-inline": "./missing.js" } }, expected: "failed" },
		{ name: "invalid-manifest", manifest: "{invalid", expected: "failed" },
		{ name: "transitive", entry: 'require("missing-transitive-fixture");', expected: "failed" },
		{ name: "evaluation", entry: 'throw Object.assign(new Error("evaluation"), { code: "MODULE_NOT_FOUND" });', expected: "failed" },
		{ name: "bad-export", entry: "exports.other = () => {};", expected: "failed" },
		{ name: "ready", entry: "exports.createCodexSubagentInlineExtension = () => ({});", expected: "ready" },
	];
	for (const scenario of cases) {
		const root = tempRoot(t);
		const entry = join(root, "integration.ts");
		writeFileSync(entry, readFileSync(resolve(import.meta.dirname, "../src/codex-integration.ts"), "utf8"));
		if (scenario.name !== "absent") {
			const target = join(root, "node_modules/@oai404iao/pi-codex-runtime");
			mkdirSync(target, { recursive: true });
			if (scenario.manifest !== undefined || scenario.entry) writeFileSync(join(target, "package.json"),
				typeof scenario.manifest === "string" ? scenario.manifest : JSON.stringify(scenario.manifest ?? {
					exports: { "./subagent-inline": "./index.js" },
				}));
			if (scenario.entry) writeFileSync(join(target, "index.js"), scenario.entry);
		}
		const result = spawnSync(process.execPath, [resolve(import.meta.dirname, "support/integration-loader.mjs"), jitiPath, entry],
			{ encoding: "utf8", timeout: 30000, env: subprocessEnv });
		assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
		const state = JSON.parse(result.stdout);
		assert.equal(state.status, scenario.expected, `${scenario.name} ${JSON.stringify(state)}`);
		if (state.status === "failed") assert.ok(state.cause, scenario.name);
	}
});

for (const selection of ["responses", "nonresponses", "virtual"]) {
	for (const openAIIdentity of [false, true]) {
		for (const status of ["absent", "failed"] as const) {
			test(`${status} integration with ${selection} identity=${openAIIdentity} preserves its gate`, async t => {
				const f = await fixture(t, { settings: { openAIIdentity },
					modelApi: selection === "nonresponses" ? "anthropic-messages" : "openai-responses", codexIntegration: status === "absent"
						? { status } : { status, cause: new Error("damaged integration") } });
				if (selection === "virtual") f.modelRuntime.registerVirtualModel({
					provider: "router", id: "auto", name: "Auto", thinkingLevels: ["off"],
					route: () => ({ model: f.model, thinkingLevel: "off" }),
				});
				const caller = selection === "virtual" ? { ...f.caller, model: f.modelRuntime.getModel("router", "auto")! } : f.caller;
				const succeeds = status === "absent" && (!openAIIdentity || selection === "nonresponses");
				const spawn = f.coordinator.spawn(caller, { task_name: "worker", message: "work" });
				if (succeeds) await spawn;
				else await assert.rejects(spawn, /integration failed|openAIIdentity requires/);
				await f.idle();
				if (succeeds) assert.equal(f.coordinator.treeStore.record("/root/worker").status, "completed");
				assert.equal(f.requests.length, succeeds ? 1 : 0);
			});
		}
	}
}
