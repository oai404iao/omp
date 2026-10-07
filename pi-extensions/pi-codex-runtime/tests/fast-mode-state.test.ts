import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { SessionManager, type ExtensionAPI, type SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	FAST_MODE_CUSTOM_TYPE,
	installFastModeLifecycle,
	sessionFastMode,
	setSessionFastMode,
	type FastModeSessionView,
} from "@oai404iao/pi-codex-runtime/internal/fast-mode-state";
import { configPath, loadSettings } from "@oai404iao/pi-codex-runtime/internal/settings";

function fixture(t: TestContext, enabled = false) {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-codex-fast-state-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	});
	const path = configPath();
	mkdirSync(dirname(path), { recursive: true });
	const writeDefault = (fastMode: boolean) => {
		writeFileSync(path, `${JSON.stringify({ fastMode, webSearchEnabled: false }, null, 2)}\n`);
	};
	writeDefault(enabled);
	return { path, writeDefault };
}

function lifecycle(t: TestContext, session: SessionManager, parent?: FastModeSessionView) {
	type Handler = (event: unknown, ctx: { sessionManager: SessionManager }) => unknown;
	const handlers = new Map<string, Handler[]>();
	const bus = new EventEmitter();
	let current = session;
	const createApi = () => ({
		on: (name: string, handler: Handler) => {
			handlers.set(name, [...handlers.get(name) ?? [], handler]);
		},
		appendEntry: (customType: string, data: unknown) => current.appendCustomEntry(customType, data),
		events: {
			emit: (name: string, data: unknown) => { bus.emit(name, data); },
			on: (name: string, handler: (data: unknown) => void) => {
				bus.on(name, handler);
				return () => { bus.off(name, handler); };
			},
		},
	} as unknown as ExtensionAPI);
	const pi = createApi();
	installFastModeLifecycle(pi, parent);
	const emit = (name: string, next = current) => {
		current = next;
		for (const handler of handlers.get(name) ?? []) handler({ type: name }, { sessionManager: current });
	};
	t.after(() => emit("session_shutdown"));
	return {
		pi,
		start: (next = current) => emit("session_start", next),
		tree: () => emit("session_tree"),
		beforeStart: () => emit("before_agent_start"),
		shutdown: () => emit("session_shutdown"),
		set: (enabled: boolean) => setSessionFastMode(pi, current, enabled),
		bindings: (name: string) => handlers.get(name)?.length ?? 0,
		install: (nextParent?: FastModeSessionView) => {
			const wrapper = createApi();
			installFastModeLifecycle(wrapper, nextParent);
			return wrapper;
		},
	};
}

function savedStates(session: SessionManager) {
	return session.getBranch().filter(
		(entry): entry is Extract<SessionEntry, { type: "custom" }> =>
			entry.type === "custom" && entry.customType === FAST_MODE_CUSTOM_TYPE,
	);
}

function value(session: SessionManager, fallback = false): boolean {
	return sessionFastMode(session.getSessionId(), fallback);
}

test("new sessions snapshot the configured default without rewriting config", t => {
	const config = fixture(t, true);
	const before = readFileSync(config.path, "utf8");
	const session = SessionManager.inMemory();
	const runtime = lifecycle(t, session);
	runtime.start();
	assert.equal(value(session), true);
	assert.deepEqual(savedStates(session).map(entry => entry.data), [
		{ version: 1, sessionId: session.getSessionId(), enabled: true },
	]);
	assert.equal(readFileSync(config.path, "utf8"), before);

	config.writeDefault(false);
	assert.equal(value(session), true);
	runtime.start();
	assert.equal(value(session), true);
	assert.equal(savedStates(session).length, 1);
	const next = SessionManager.inMemory();
	lifecycle(t, next).start();
	assert.equal(value(next, true), false);
	assert.equal(sessionFastMode(undefined, true), true);
	assert.equal(sessionFastMode("unknown-session", false), false);
});

test("setting session Fast mode persists entries but leaves defaults and other sessions untouched", t => {
	const config = fixture(t);
	const before = readFileSync(config.path, "utf8");
	const session = SessionManager.inMemory();
	const other = SessionManager.inMemory();
	const runtime = lifecycle(t, session);
	runtime.start();
	lifecycle(t, other).start();
	runtime.set(true);
	assert.equal(value(session), true);
	assert.equal(value(other, true), false);
	assert.equal(loadSettings().fastMode, false);
	assert.equal(readFileSync(config.path, "utf8"), before);
	assert.deepEqual(savedStates(session).at(-1)?.data, {
		version: 1, sessionId: session.getSessionId(), enabled: true,
	});
	runtime.set(false);
	assert.equal(value(session, true), false);
	assert.equal(savedStates(session).length, 3);
	assert.equal(readFileSync(config.path, "utf8"), before);
});

test("reload restores saved state rather than a changed default and ignores malformed entries", t => {
	const config = fixture(t);
	const session = SessionManager.inMemory();
	const old = lifecycle(t, session);
	old.start();
	old.set(true);
	old.shutdown();
	assert.equal(value(session), false);
	config.writeDefault(false);
	for (const data of [
		null,
		{ version: 2, sessionId: session.getSessionId(), enabled: false },
		{ version: 1, sessionId: session.getSessionId(), enabled: "false" },
		{ version: 1, sessionId: session.getSessionId(), enabled: false, rootSessionId: 1 },
	]) session.appendCustomEntry(FAST_MODE_CUSTOM_TYPE, data);
	const count = session.getEntries().length;
	lifecycle(t, session).start();
	assert.equal(value(session), true);
	assert.equal(session.getEntries().length, count);
});

test("tree navigation restores only the active branch and forks detach inherited root links", t => {
	fixture(t);
	const session = SessionManager.inMemory();
	const runtime = lifecycle(t, session);
	runtime.start();
	const initial = session.getLeafId()!;
	runtime.set(true);
	const enabledBranch = session.getLeafId()!;
	session.branch(initial);
	runtime.tree();
	assert.equal(value(session, true), false);
	runtime.set(false);
	session.branch(enabledBranch);
	runtime.tree();
	assert.equal(value(session), true);

	runtime.set(false);
	const child = SessionManager.inMemory();
	lifecycle(t, child, session).start();
	runtime.set(true);
	assert.deepEqual(savedStates(child).at(-1)?.data, {
		version: 1, sessionId: child.getSessionId(), enabled: false, rootSessionId: session.getSessionId(),
	});
	const fork = SessionManager.inMemory(undefined, undefined, structuredClone(child.getBranch()));
	assert.notEqual(fork.getSessionId(), child.getSessionId());
	const forkRuntime = lifecycle(t, fork);
	forkRuntime.start();
	assert.deepEqual(savedStates(fork).at(-1)?.data, {
		version: 1, sessionId: fork.getSessionId(), enabled: true,
	});
	runtime.set(false);
	assert.equal(value(fork), true);
	forkRuntime.set(false);
	assert.equal(value(fork, true), false);
});

test("child and grandchild follow live root changes after intermediate unload and rehydration", t => {
	fixture(t);
	const root = SessionManager.inMemory();
	const rootRuntime = lifecycle(t, root);
	rootRuntime.start();
	const child = SessionManager.inMemory();
	const childRuntime = lifecycle(t, child, root);
	childRuntime.start();
	const grandchild = SessionManager.inMemory();
	const grandchildRuntime = lifecycle(t, grandchild, child);
	grandchildRuntime.start();
	for (const session of [child, grandchild]) {
		assert.deepEqual(savedStates(session).at(-1)?.data, {
			version: 1, sessionId: session.getSessionId(), enabled: false, rootSessionId: root.getSessionId(),
		});
	}
	rootRuntime.set(true);
	assert.equal(value(child), true);
	assert.equal(value(grandchild), true);
	assert.throws(() => childRuntime.set(false), /follows the main agent/);
	assert.throws(() => grandchildRuntime.set(false), /follows the main agent/);
	assert.equal(value(root), true);

	childRuntime.shutdown();
	rootRuntime.set(false);
	assert.equal(value(grandchild, true), false);
	const lateGrandchild = SessionManager.inMemory();
	lifecycle(t, lateGrandchild, child).start();
	rootRuntime.set(true);
	assert.equal(value(grandchild), true);
	assert.equal(value(lateGrandchild), true);
	const rehydratedChild = lifecycle(t, child, root);
	rehydratedChild.start();
	assert.equal(value(child), true);
	childRuntime.shutdown();
	assert.equal(value(child), true);
	grandchildRuntime.shutdown();
	lifecycle(t, grandchild, child).start();
	rootRuntime.set(false);
	for (const session of [child, grandchild, lateGrandchild]) assert.equal(value(session, true), false);
});

test("saved inline state with an explicit parent restores inheritance and falls back after root shutdown", t => {
	fixture(t);
	const root = SessionManager.inMemory();
	const rootRuntime = lifecycle(t, root);
	rootRuntime.start();
	rootRuntime.set(true);
	const child = SessionManager.inMemory();
	const childRuntime = lifecycle(t, child, root);
	childRuntime.start();
	childRuntime.shutdown();
	const restored = lifecycle(t, child, root);
	restored.start();
	rootRuntime.set(false);
	assert.equal(value(child, true), false);
	rootRuntime.shutdown();
	assert.equal(value(child), true);
	assert.throws(() => restored.set(false), /follows the main agent/);
	lifecycle(t, root).start();
	assert.equal(value(child, true), false);
});

test("standalone child resume snapshots live inherited state, detaches, and permits switching Fast mode", t => {
	fixture(t);
	const root = SessionManager.inMemory();
	const rootRuntime = lifecycle(t, root);
	rootRuntime.start();
	const child = SessionManager.inMemory();
	const inline = lifecycle(t, child, root);
	inline.start();
	rootRuntime.set(true);
	inline.shutdown();
	const standalone = lifecycle(t, child);
	standalone.start();
	assert.equal(value(child), true);
	assert.deepEqual(savedStates(child).at(-1)?.data, {
		version: 1, sessionId: child.getSessionId(), enabled: true,
	});
	rootRuntime.set(false);
	assert.equal(value(child), true);
	standalone.set(false);
	assert.equal(value(child, true), false);
	rootRuntime.set(true);
	assert.equal(value(child, true), false);
});

test("child turn boundaries refresh the persisted fallback snapshot for standalone resume", t => {
	fixture(t);
	const root = SessionManager.inMemory();
	const rootRuntime = lifecycle(t, root);
	rootRuntime.start();
	const child = SessionManager.inMemory();
	const inline = lifecycle(t, child, root);
	inline.start();
	rootRuntime.set(true);
	inline.beforeStart();
	assert.deepEqual(savedStates(child).at(-1)?.data, {
		version: 1, sessionId: child.getSessionId(), enabled: true, rootSessionId: root.getSessionId(),
	});
	const count = savedStates(child).length;
	inline.beforeStart();
	assert.equal(savedStates(child).length, count);
	inline.shutdown();
	rootRuntime.shutdown();
	const standalone = lifecycle(t, child);
	standalone.start();
	assert.equal(value(child), true);
	standalone.set(false);
	assert.equal(value(child, true), false);
});

for (const order of ["core-first", "inline-first"] as const) {
	test(`shared event bus deduplicates distinct API wrappers with ${order} installation`, t => {
		fixture(t);
		const root = SessionManager.inMemory();
		const rootRuntime = lifecycle(t, root);
		rootRuntime.start();
		const child = SessionManager.inMemory();
		const runtime = lifecycle(t, child, order === "inline-first" ? root : undefined);
		const wrapper = runtime.install(order === "core-first" ? root : undefined);
		assert.notEqual(wrapper, runtime.pi);
		assert.notEqual(wrapper.events, runtime.pi.events);
		assert.equal(runtime.bindings("session_start"), 1);
		assert.equal(runtime.bindings("before_agent_start"), 1);
		assert.equal(runtime.bindings("session_shutdown"), 1);
		runtime.start();
		assert.equal(savedStates(child).length, 1);
		rootRuntime.set(true);
		assert.equal(value(child), true);
		assert.throws(() => runtime.set(false), /follows the main agent/);
		rootRuntime.set(false);
		assert.equal(value(child, true), false);
	});
}

test("session replacement and shutdown release only the lifecycle's current owner", t => {
	fixture(t);
	const first = SessionManager.inMemory();
	const old = lifecycle(t, first);
	old.start();
	old.set(true);
	const second = SessionManager.inMemory();
	old.start(second);
	assert.equal(value(first), false);
	old.set(true);
	const replacement = lifecycle(t, second);
	replacement.start();
	old.shutdown();
	assert.equal(value(second), true);
	old.shutdown();
	assert.equal(value(second), true);
	replacement.shutdown();
	assert.equal(value(second), false);
	assert.equal(value(second, true), true);
});

test("failed persistence does not change the effective session state", t => {
	fixture(t);
	const session = SessionManager.inMemory();
	lifecycle(t, session).start();
	const failing = { appendEntry: () => { throw new Error("append failed"); } } as unknown as ExtensionAPI;
	assert.throws(() => setSessionFastMode(failing, session, true), /append failed/);
	assert.equal(value(session, true), false);
	assert.equal(savedStates(session).length, 1);
});
