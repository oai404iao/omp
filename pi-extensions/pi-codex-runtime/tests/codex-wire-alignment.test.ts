import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { SessionManager, createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	advanceCodexWindow, beginCodexTurn, captureCodexTurnAttribution, createCodexChildIdentity,
	createCodexRootIdentity, endCodexTurn, parseCodexThreadIdentity, registerCodexThreadIdentity,
	resetCodexWireState, resolveCodexRequestIdentity, setCodexInstallationId,
	type CodexRequestIdentity,
} from "../src/codex-wire-identity.js";
import { codexInstallationIdFor } from "../src/codex-installation.js";
import {
	asciiJson, buildCodexClientMetadata, buildCodexCompatibilityMetadataJson,
	buildCodexExternalToolMetadataJson, buildCodexTurnMetadata,
} from "../src/codex-metadata.js";
import { CODEX_IDENTITY_CUSTOM_TYPE, ensureCodexSessionIdentity, installCodexIdentityLifecycle } from "../src/codex-identity-extension.js";
import { TURN_ATTRIBUTION_CHANNEL, TURN_ATTRIBUTION_CUSTOM_TYPE } from "../src/codex-session-lineage.js";

const installationId = "11111111-1111-4111-8111-111111111111";
beforeEach(() => { resetCodexWireState(); setCodexInstallationId(installationId); });
afterEach(() => resetCodexWireState());

test("wire window is thread:number while context UUID rotates and survives old session migration", () => {
	const identity = createCodexRootIdentity("root");
	const { contextWindowId, ...old } = identity;
	const legacy = { ...old, windowId: contextWindowId, agentName: "root" };
	const migrated = parseCodexThreadIdentity(legacy);
	assert.equal(migrated.contextWindowId, contextWindowId);
	assert.equal(migrated.firstWindowId, contextWindowId);
	assert.equal(migrated.windowId, `${identity.threadId}:0`);
	assert.equal(migrated.agentName, "/root");
	registerCodexThreadIdentity(migrated);
	const next = advanceCodexWindow("root", "compact");
	assert.equal(next.windowId, `${identity.threadId}:1`);
	assert.equal(next.previousWindowId, contextWindowId);
	assert.notEqual(next.contextWindowId, contextWindowId);
	assert.deepEqual(advanceCodexWindow("root", "compact"), next);
	assert.equal(resolveCodexRequestIdentity("root", undefined)?.windowNumber, 1);
	assert.deepEqual(parseCodexThreadIdentity(next), next);
});

test("legacy session identity is upgraded durably without replacing its session/thread/context IDs", () => {
	const session = SessionManager.inMemory();
	const identity = createCodexRootIdentity(session.getSessionId());
	const { contextWindowId, ...old } = identity;
	session.appendCustomEntry(CODEX_IDENTITY_CUSTOM_TYPE, { ...old, windowId: contextWindowId, agentName: "root" });
	const migrated = ensureCodexSessionIdentity(session);
	assert.equal(session.getEntries().length, 2);
	assert.equal(migrated.threadId, identity.threadId);
	assert.equal(migrated.contextWindowId, contextWindowId);
	assert.equal(migrated.windowId, `${identity.threadId}:0`);
	resetCodexWireState();
	assert.deepEqual(ensureCodexSessionIdentity(session), migrated);
	assert.equal(session.getEntries().length, 2);
});

test("child metadata distinguishes header source and kind and uses canonical task path", () => {
	const root = createCodexRootIdentity("root");
	const child = createCodexChildIdentity("child", root, { relation: "fork", agentName: "/root/worker/nested" });
	registerCodexThreadIdentity(child);
	const identity = resolveCodexRequestIdentity("child", undefined)!;
	assert.equal(identity.agentName, "/root/worker/nested");
	assert.equal(identity.subagentKind, "thread_spawn");
	assert.equal(identity.subagentHeader, "collab_spawn");
	assert.equal(buildCodexClientMetadata(identity)["x-openai-subagent"], "collab_spawn");
	const body = buildCodexTurnMetadata(identity);
	assert.equal(body.subagent_kind, "thread_spawn");
	assert.equal(body.forked_from_thread_id, undefined);
	assert.equal(body.parent_thread_id, root.threadId);
	assert.equal(JSON.parse(buildCodexExternalToolMetadataJson(identity)).forked_from_thread_id, root.threadId);
});

test("new lineage repairs a previously root-attributed v5 child while preserving its thread and context", () => {
	const parent = SessionManager.inMemory();
	const root = ensureCodexSessionIdentity(parent);
	const child = SessionManager.inMemory();
	const old = ensureCodexSessionIdentity(child);
	child.appendCustomEntry("pi-subagent/lineage", {
		version: 1, openAIIdentity: true, agentId: "worker", parentAgentId: "root",
		parentPiSessionId: parent.getSessionId(), relation: "fork",
		agentPath: "/root/worker",
	});
	const repaired = ensureCodexSessionIdentity(child);
	assert.equal(repaired.sessionId, root.sessionId);
	assert.equal(repaired.parentThreadId, root.threadId);
	assert.equal(repaired.threadId, old.threadId);
	assert.equal(repaired.contextWindowId, old.contextWindowId);
	assert.equal(repaired.agentName, "/root/worker");
	assert.equal(repaired.subagentKind, "thread_spawn");
	assert.deepEqual(ensureCodexSessionIdentity(child), repaired);
});

test("shared metadata emits actual execution/compaction state and ASCII-safe projections only", () => {
	registerCodexThreadIdentity(createCodexRootIdentity("root"));
	const identity: CodexRequestIdentity = {
		...resolveCodexRequestIdentity("root", undefined, "compaction")!,
		agentName: "/root/审查😀", model: "fixture", reasoningEffort: "high",
		compaction: { trigger: "manual", reason: "user_requested", implementation: "remote", phase: "before_turn", strategy: "memento" },
	};
	const headers = new Headers({ "x-codex-turn-metadata": buildCodexCompatibilityMetadataJson(identity) });
	const metadata = JSON.parse(headers.get("x-codex-turn-metadata")!);
	assert.equal(metadata.agent_name, identity.agentName);
	assert.equal(metadata.model, "fixture");
	assert.equal(metadata.reasoning_effort, "high");
	assert.equal(metadata.window_id, `${identity.threadId}:0`);
	assert.equal(metadata.context_window_id, identity.contextWindowId);
	assert.deepEqual(metadata.compaction, identity.compaction);
	assert.match(asciiJson({ text: "审查😀" }), /^[\x00-\x7f]+$/);
	const external = JSON.parse(buildCodexExternalToolMetadataJson(identity));
	assert.equal(external.model, "fixture");
	for (const key of ["installation_id", "window_id", "window_number", "context_window_id", "request_kind", "agent_name", "parent_turn_id", "root_turn_id", "compaction", "codex_version", "sandbox"]) {
		assert.equal(external[key], undefined, key);
	}
	assert.equal(metadata.codex_version, undefined);
	assert.equal(metadata.sandbox, undefined);
});

test("captured task cause survives parent completion and runtime reset", async () => {
	const parent = createCodexRootIdentity("parent");
	registerCodexThreadIdentity(parent);
	const turn = beginCodexTurn("parent");
	const attribution = captureCodexTurnAttribution("parent");
	endCodexTurn("parent");
	const child = SessionManager.inMemory();
	child.appendCustomEntry(TURN_ATTRIBUTION_CUSTOM_TYPE, { version: 1, ...attribution });
	resetCodexWireState();
	setCodexInstallationId(installationId);
	const handlers: Record<string, Function[]> = {};
	const events = createEventBus();
	const pi = {
		events,
		on(name: string, handler: Function) { (handlers[name] ??= []).push(handler); },
		appendEntry(type: string, data: unknown) { child.appendCustomEntry(type, data); },
	} as unknown as ExtensionAPI;
	installCodexIdentityLifecycle(pi);
	for (const handler of handlers.before_agent_start ?? []) await handler({}, { sessionManager: child });
	const active = resolveCodexRequestIdentity(child.getSessionId(), undefined)!;
	assert.equal(active.parentTurnId, turn.turnId);
	assert.equal(active.rootTurnId, turn.turnId);
	let captured: unknown;
	events.emit(TURN_ATTRIBUTION_CHANNEL, { sessionId: child.getSessionId(), accept(value: unknown) { captured = value; } });
	assert.deepEqual(captured, { parentTurnId: active.turnId, rootTurnId: turn.turnId });
	for (const handler of handlers.agent_settled ?? []) await handler({}, { sessionManager: child });
	child.appendCustomEntry(TURN_ATTRIBUTION_CUSTOM_TYPE, { version: 1 });
	for (const handler of handlers.before_agent_start ?? []) await handler({}, { sessionManager: child });
	const fresh = resolveCodexRequestIdentity(child.getSessionId(), undefined)!;
	assert.equal(fresh.parentTurnId, undefined);
	assert.equal(fresh.rootTurnId, fresh.turnId);
	for (const handler of handlers.session_shutdown ?? []) await handler({}, { sessionManager: child });
});

test("explicit wire window and context metadata are projected separately", () => {
	registerCodexThreadIdentity(createCodexRootIdentity("root"));
	const original = resolveCodexRequestIdentity("root", undefined)!;
	const explicitContext = createCodexRootIdentity("unused").contextWindowId;
	const identity = resolveCodexRequestIdentity("root", {
		window_id: `${original.threadId}:7`, context_window_id: explicitContext,
	})!;
	assert.equal(identity.windowNumber, 7);
	assert.equal(identity.windowId, `${original.threadId}:7`);
	assert.equal(identity.contextWindowId, explicitContext);
});

for (const legacy of [false, true]) test(`tree navigation and next turn keep the selected window (${legacy ? "legacy migration" : "current entry"})`, async () => {
	const session = SessionManager.inMemory();
	const initial = createCodexRootIdentity(session.getSessionId());
	const { contextWindowId, ...old } = initial;
	const initialEntry = session.appendCustomEntry(CODEX_IDENTITY_CUSTOM_TYPE,
		legacy ? { ...old, windowId: contextWindowId, agentName: "root" } : initial);
	registerCodexThreadIdentity(initial);
	const abandoned = advanceCodexWindow(session.getSessionId(), "abandoned-compaction");
	session.appendCustomEntry(CODEX_IDENTITY_CUSTOM_TYPE, abandoned);
	const handlers: Record<string, Function[]> = {};
	const pi = {
		events: createEventBus(),
		on(name: string, handler: Function) { (handlers[name] ??= []).push(handler); },
		appendEntry(type: string, data: unknown) { session.appendCustomEntry(type, data); },
	} as unknown as ExtensionAPI;
	installCodexIdentityLifecycle(pi);
	const emit = async (name: string) => {
		for (const handler of handlers[name] ?? []) await handler({}, { sessionManager: session });
	};
	session.branch(initialEntry);
	await emit("session_tree");
	await emit("before_agent_start");
	const selected = resolveCodexRequestIdentity(session.getSessionId(), undefined)!;
	assert.equal(selected.windowId, initial.windowId);
	assert.equal(selected.contextWindowId, initial.contextWindowId);
	assert.equal(selected.windowNumber, 0);
	assert.equal(session.getEntries().length, legacy ? 3 : 2);
	assert(!session.getBranch().some(entry => entry.type === "custom"
		&& (entry.data as { windowNumber?: number }).windowNumber === 1));
	await emit("session_shutdown");
	resetCodexWireState();
	assert.deepEqual(ensureCodexSessionIdentity(session), initial);
});

test("concurrent installation initialization yields one durable identity across processes", async () => {
	const directory = mkdtempSync(join(tmpdir(), "codex-installation-race-"));
	const path = join(directory, "installation_id");
	const moduleUrl = new URL("../src/codex-installation.ts", import.meta.url).href;
	const run = promisify(execFile);
	try {
		const results = await Promise.all(Array.from({ length: 8 }, () => run(process.execPath, [
			"--import", "tsx", "--input-type=module", "-e",
			`const {codexInstallationIdFor}=await import(${JSON.stringify(moduleUrl)});console.log(codexInstallationIdFor());`,
		], { cwd: resolve(import.meta.dirname, "../../.."), env: { ...process.env, PI_CODEX_INSTALLATION_ID_PATH: path } })));
		const ids = results.map(result => result.stdout.trim());
		assert.equal(new Set(ids).size, 1);
		assert.equal(readFileSync(path, "utf8").trim(), ids[0]);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("installation repair is durable and read failures do not silently invent process-local IDs", () => {
	const directory = mkdtempSync(join(tmpdir(), "codex-installation-repair-"));
	const previous = process.env.PI_CODEX_INSTALLATION_ID_PATH;
	try {
		const path = join(directory, "installation_id");
		process.env.PI_CODEX_INSTALLATION_ID_PATH = path;
		writeFileSync(path, "invalid");
		const id = codexInstallationIdFor();
		resetCodexWireState();
		assert.equal(codexInstallationIdFor(), id);
		process.env.PI_CODEX_INSTALLATION_ID_PATH = directory;
		assert.throws(() => codexInstallationIdFor(), /EISDIR/);
	} finally {
		if (previous === undefined) delete process.env.PI_CODEX_INSTALLATION_ID_PATH;
		else process.env.PI_CODEX_INSTALLATION_ID_PATH = previous;
		rmSync(directory, { recursive: true, force: true });
	}
});
