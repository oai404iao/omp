import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createEventBus, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CHANGED, DISCOVER, DISCOVER_V2, registerCodeModePolicy, registerCodeModeTools,
	type CodeModePolicy, type CodeModeProvider, type CodeModeTool } from "../src/contributions.ts";
import type { DiscoveryV2 } from "../src/discovery.ts";
import { collect } from "../src/catalog.ts";
import { Cell } from "../src/cell.ts";
import { ToolBridge } from "../src/bridge.ts";
import { Runtime } from "../src/runtime.ts";
import { piSession, scratch } from "./helpers.ts";

const api = () => ({ events: createEventBus() }) as unknown as ExtensionAPI;
const tool: CodeModeTool = { name: "write", description: "Fixture effect", parameters: Type.Object({}), effect: "write",
	invoke: async () => ({ value: null }) };

test("required policies: missing, pre-offer failure, invalid, incompatible and not-ready block the whole catalog", (t) => {
	const pi = api();
	registerCodeModeTools(pi, { id: "fixture", tools: [tool] });
	assert.throws(() => collect(pi, ["permission__guard"]), /Missing required/);
	const errors: unknown[] = [];
	t.mock.method(console, "error", (...args: unknown[]) => { errors.push(args); });
	const offThrow = pi.events.on(DISCOVER_V2, () => { throw new Error("failure before offer"); });
	assert.throws(() => collect(pi, ["permission__guard"]), /Missing required/);
	assert.equal(errors.length, 1, "Pi swallowed the listener error, not the mandatory expectation");
	offThrow();
	for (const state of ["not-ready", "failed", "incompatible", "invalid"] as const) {
		const off = pi.events.on(DISCOVER_V2, (value) => {
			(value as DiscoveryV2).offer({
				kind: "policy", registration: { owner: "permission__guard", instanceId: "fixture", revision: 1 },
				requires: state === "incompatible" ? ["unknown/1"] : [],
				...(state === "not-ready" || state === "failed" ? { availability: { state } } : { policy: { id: "permission__guard" } }),
			});
		});
		assert.throws(() => collect(pi, ["permission__guard"]), /Invalid|not-ready/);
		off();
	}
	const offLegacy = pi.events.on(DISCOVER, (value) => {
		(value as { policy(policy: CodeModePolicy): void }).policy({ id: "permission__guard", before: () => ({ block: true }) });
	});
	assert.equal(collect(pi, ["permission__guard"]).policies.length, 1, "audited v1 guards remain enforceable");
	offLegacy();
});

test("policy resolver: not-ready evidence precedes resolution; failure keeps legacy protection and recovery is explicit", () => {
	const pi = api();
	const offered: string[] = [];
	let fail = true;
	let probing = true;
	const guard = registerCodeModePolicy(pi, { id: "guard", resolve() {
		if (probing) assert.equal(offered.at(-1), "not-ready");
		if (fail) throw new Error("private backend configuration");
		return { id: "guard", before: () => ({ block: true }) };
	} });
	const hello: DiscoveryV2["hello"] = { protocol: 2, instanceId: "fixture", generation: 1, features: ["approval/1"],
		limits: { resultBytes: 65536, callsPerCell: 32, maxCells: 4 } };
	pi.events.emit(DISCOVER_V2, { hello, offer(value) {
		if (value.kind === "policy") offered.push(value.availability?.state ?? "available");
		return { status: "unavailable" };
	} } satisfies DiscoveryV2);
	probing = false;
	assert.deepEqual(offered, ["not-ready", "failed"]);
	assert.throws(() => collect(pi, ["guard"]), /not-ready/);
	const policies: CodeModePolicy[] = [];
	pi.events.emit(DISCOVER, { version: 1, provider() {}, policy(value: CodeModePolicy) { policies.push(value); } });
	assert.deepEqual(policies[0].before!({} as never), { block: true, reason: "Code Mode policy unavailable or requires negotiated approval/1 support" });
	fail = false;
	guard.refresh();
	assert.equal(collect(pi, ["guard"]).policies.length, 1);
	guard();
	assert.throws(() => collect(pi, ["guard"]), /Missing required/);
});

test("legacy running cell: safe-to-approval refresh aborts queued and subsequent effects from the old closure", async () => {
	const pi = api();
	let entered!: () => void, finish!: () => void;
	const started = new Promise<void>((resolve) => { entered = resolve; });
	const held = new Promise<void>((resolve) => { finish = resolve; });
	let effects = 0;
	const guarded = { ...tool, invoke: async () => { effects++; return { value: null }; } };
	const registration = registerCodeModeTools(pi, { id: "fixture", tools: [
		{ ...tool, name: "hold", invoke: async () => { entered(); await held; return { value: null }; } }, guarded,
	] });
	const providers: CodeModeProvider[] = [];
	pi.events.emit(DISCOVER, { version: 1, provider: (p: CodeModeProvider) => providers.push(p), policy() {} });
	// The initial ABI ignores approval metadata entirely.
	const captured = providers.flatMap((p) => p.tools).map(({ approval: _ignored, ...value }) => value);
	const cell = new Cell(5000, async (current) => {
		current.bridge = new ToolBridge(captured, [], current.id, ".", current.controller.signal, () => undefined, () => {}, () => {});
		const hold = current.bridge.invoke("hold", {}, "hold", current.controller.signal);
		const write = assert.rejects(current.bridge.invoke("write", {}, "queued", current.controller.signal));
		await assert.rejects(hold);
		await write;
		await assert.rejects(current.bridge.invoke("write", {}, "late", current.controller.signal));
		return "terminated";
	});
	const off = pi.events.on(CHANGED, (message) => {
		if ((message as { version?: number }).version === 1) cell.cancel("Legacy catalog revoked");
	});
	try {
		await started;
		registration.refresh([{ ...guarded, approval: "user" }]);
		assert(cell.controller.signal.aborted, "v1 revocation is synchronous");
		finish();
		await cell.finished;
		assert.equal(effects, 0);
	} finally { finish(); off(); registration.dispose(); cell.cancel("fixture complete"); }
});

test("real Pi: required policy absence blocks local tools before Host startup; late registration can recover", async (t) => {
	const cwd = await scratch("required-policy");
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
	t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
	const config = join(cwd, "agent/extensions/pi-code-mode");
	await mkdir(config, { recursive: true });
	await writeFile(join(config, "config.json"), JSON.stringify({ version: 1, requiredPolicies: ["permission__guard"] }));
	let pi!: ExtensionAPI, ctx!: ExtensionContext;
	const f = await piSession(t, { cwd, host: "/fixture", grant: true,
		factory(api) { pi = api; api.on("session_start", (_e, context) => { ctx = context; }); } });
	let starts = 0;
	t.mock.method(Runtime, "create", async () => { starts++; throw new Error("Host reached"); });
	const exec = f.session.getToolDefinition("exec")!;
	await assert.rejects(exec.execute("test", { code: "text(await tools.read({path:'secret'}))" }, undefined, undefined, ctx), /Missing required/);
	assert.equal(starts, 0);
	assert(f.errors.some((error) => error.includes("Missing required")));
	const guard = registerCodeModePolicy(pi, { id: "permission__guard", before: () => ({ block: true }) });
	await f.session.prompt("/code-mode visibility mixed");
	assert.equal(collect(pi, ["permission__guard"]).policies.length, 1);
	assert.match(f.session.getAllTools().find((tool) => tool.name === "exec")!.description, /tools\.read/);
	guard();
	await assert.rejects(exec.execute("test2", { code: "text(1)" }, undefined, undefined, ctx), /Missing required/);
	assert.equal(starts, 0);
});
