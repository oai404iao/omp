import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createEventBus, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { configuration } from "../src/config.ts";
import { scratch, piSession } from "./helpers.ts";
import { doctor } from "../src/doctor.ts";
import { Runtime } from "../src/runtime.ts";

test("config: defaults, user settings, explicit CLI and strict non-permission schema", async () => {
	const dir = await scratch("config");
	const path = join(dir, "extensions/pi-code-mode/config.json");
	await mkdir(join(dir, "extensions/pi-code-mode"), { recursive: true });
	const flags: Record<string, string | boolean> = {};
	const pi = { getFlag: (name: string) => flags[name] } as Pick<ExtensionAPI, "getFlag">;
	assert.deepEqual(configuration(pi, dir).value, { hostPath: "", protocol: "json", visibility: "mixed", maxCells: 1 });
	await writeFile(path, JSON.stringify({ version: 1, hostPath: "/host", protocol: "auto", visibility: "hide-bridged" }));
	assert.equal(configuration(pi, dir).sources.hostPath, "config");
	flags["code-mode-protocol"] = "json";
	flags["code-mode-visibility"] = "mixed";
	flags["code-mode-host"] = "/cli-host";
	assert.deepEqual(configuration(pi, dir).value, { hostPath: "/cli-host", protocol: "json", visibility: "mixed", maxCells: 1 });
	assert.equal(configuration(pi, dir).sources.protocol, "CLI");
	await writeFile(path, JSON.stringify({ version: 1, maxCells: 2 }));
	assert.equal(configuration(pi, dir).value.maxCells, 2);
	flags["code-mode-max-cells"] = "4";
	assert.equal(configuration(pi, dir).value.maxCells, 4);
	assert.equal(configuration(pi, dir).sources.maxCells, "CLI");
	for (const invalid of ["0", "5", "2.5", " 2", "02", true]) {
		flags["code-mode-max-cells"] = invalid;
		assert.throws(() => configuration(pi, dir), /maxCells/);
	}
	delete flags["code-mode-max-cells"];
	for (const invalid of [{}, [], null, { version: 2 }, { version: 1, write: true },
		...[0, 5, 1.5, "2", null].map((maxCells) => ({ version: 1, maxCells })),
		{ version: 1, tools: ["any"] }, { version: 1, hostPath: "relative" },
		{ version: 1, protocol: "unknown" }, { version: 1, visibility: "only" }]) {
		await writeFile(path, JSON.stringify(invalid));
		assert.throws(() => configuration(pi, dir), /Invalid Code Mode configuration/);
	}
	await writeFile(path, " ".repeat(17 * 1024));
	assert.throws(() => configuration(pi, dir), /configuration/);
});

test("real Pi: user protocol config does not grant execution; explicit json beats config grammar", async (t) => {
	const cwd = await scratch("config-pi");
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
	t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
	const dir = join(cwd, "agent/extensions/pi-code-mode");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "config.json"), JSON.stringify({ version: 1, hostPath: "/fixture-not-executed", protocol: "grammar" }));
	const f = await piSession(t, { cwd, protocol: "json", grammar: true });
	assert(!f.session.getActiveToolNames().includes("exec"));
	assert.deepEqual(f.errors, []);
});

test("real Pi: configuration host/protocol are used, command override is temporary across reload", async (t) => {
	const cwd = await scratch("config-enabled");
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
	t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
	const dir = join(cwd, "agent/extensions/pi-code-mode");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "config.json"), JSON.stringify({ version: 1, hostPath: "/fixture-not-executed", protocol: "auto" }));
	const f = await piSession(t, { cwd, grant: true, grammar: true });
	assert.match(f.session.getAllTools().find(t => t.name === "exec")!.description, /raw JavaScript grammar/);
	await f.session.prompt("/code-mode protocol json");
	assert.match(f.session.getAllTools().find(t => t.name === "exec")!.description, /Protocol: JSON/);
	await f.session.reload();
	assert.match(f.session.getAllTools().find(t => t.name === "exec")!.description, /raw JavaScript grammar/);
	assert.deepEqual(f.errors, []);
});

test("doctor static checks never start a Host, even for a missing executable", async (t) => {
	const create = Runtime.create;
	let starts = 0;
	Runtime.create = async () => { starts++; throw new Error("must not start"); };
	t.after(() => { Runtime.create = create; });
	const pi = { getFlag: (name: string) => name === "code-mode-host" ? "/nonexistent/code-mode-host" : undefined,
		events: createEventBus() } as unknown as ExtensionAPI;
	const report = await doctor(pi, { cwd: await scratch("doctor") } as ExtensionContext, false);
	assert.equal(starts, 0);
	assert.match(report, /Host file\/hash\/platform: FAILED/);
	assert.match(report, /Static checks only; no Host started and no authority granted/);
});
