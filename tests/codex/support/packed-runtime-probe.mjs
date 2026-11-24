import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [piVersion, versionA, versionB, cwdA, cwdB] = process.argv.slice(2);
globalThis.fetch = async () => { throw new Error("Network is forbidden in mixed runtime probes"); };
const name = "@oai404iao/pi-codex-runtime";
const sdkDir = realpathSync(join(cwdA, "node_modules/@earendil-works/pi-coding-agent"));
const sdk = await import(pathToFileURL(join(sdkDir, "dist/index.js")));
assert.equal(sdk.VERSION, piVersion);
const { loadExtensionFromFactory, createExtensionRuntime } = await import(pathToFileURL(join(sdkDir, "dist/core/extensions/loader.js")));
const { createJiti } = await import(pathToFileURL(createRequire(join(sdkDir, "package.json")).resolve("jiti")));

async function fromArchive(cwd, version) {
  const anchor = join(cwd, "package.json");
  const dir = realpathSync(join(cwd, "node_modules", name));
  assert.ok(dir.startsWith(`${cwd}/`));
  assert.equal(JSON.parse(readFileSync(join(dir, "package.json"))).version, version);
  const jiti = createJiti(anchor, { moduleCache: false, fsCache: false });
  const load = subpath => {
    const entry = realpathSync(createRequire(anchor).resolve(name + subpath));
    assert.ok(entry.startsWith(`${dir}/`));
    return jiti.import(entry);
  };
  const [runtime, inline, fast, identity] = await Promise.all([
    load(""), load("/subagent-inline"), load("/internal/fast-mode-state"), load("/internal/codex-wire-identity"),
  ]);
  assert.equal(runtime.CODEX_RUNTIME_VERSION, version);
  return { runtime, inline, fast, identity };
}

const a = await fromArchive(cwdA, versionA);
const b = await fromArchive(cwdB, versionB);
assert.notEqual(a.runtime.CODEX_RUNTIME_VERSION, b.runtime.CODEX_RUNTIME_VERSION);
const bus = sdk.createEventBus();
let previous;
for (const inlineFirst of [false, true]) {
  const host = createExtensionRuntime();
  const parent = sdk.SessionManager.inMemory(cwdA);
  const child = sdk.SessionManager.inMemory(cwdA);
  const ctx = { cwd: cwdA, hasUI: false, sessionManager: child };
  child.appendCustomEntry("pi-subagent/lineage", { version: 1, openAIIdentity: true, parentPiSessionId: parent.getSessionId(),
    agentId: "child", parentAgentId: "root", relation: "spawn", agentPath: "/root/child" });
  const appendParent = { appendEntry: (name, data) => parent.appendCustomEntry(name, data) };
  a.fast.setSessionFastMode(appendParent, parent, true);
  host.appendEntry = (name, data) => child.appendCustomEntry(name, data);
  host.getActiveTools = () => [];
  host.setActiveTools = () => {};
  const inline = b.inline.createCodexSubagentInlineExtension({ parentSessionManager: parent });
  const factories = [a.runtime.ensureCodexServices, inline.factory];
  const extensions = [];
  const brokers = [];
  for (const factory of inlineFirst ? factories.reverse() : factories) {
    extensions.push(await loadExtensionFromFactory(async pi => {
      await factory(pi);
      const cached = a.runtime.getCodexBroker(pi);
      // The second module must validate the first module's cache on this very API.
      assert.equal(b.runtime.getCodexBroker(pi), cached);
      brokers.push(cached);
    }, cwdA, bus, host));
  }
  const [broker] = brokers;
  assert.equal(broker, brokers[1]);
  assert.notEqual(broker, previous, "reload must not rediscover a closed broker");
  assert.equal(broker.runtimeVersion, inlineFirst ? versionB : versionA);
  assert.equal(broker.claim("mixed"), true);
  assert.equal(brokers[1].claim("mixed"), false);
  const emit = async event => {
    for (const extension of extensions) for (const handler of extension.handlers.get(event) ?? []) await handler({ type: event }, ctx);
  };
  try {
    await emit("session_start");
    const childId = child.getSessionId();
    const identity = a.identity.codexThreadIdentityFor(childId);
    assert.deepEqual(identity, b.identity.codexThreadIdentityFor(childId));
    assert.equal(identity.parentThreadId, a.identity.codexThreadIdentityFor(parent.getSessionId()).threadId);
    assert.equal(a.fast.sessionFastMode(childId, false), true);
    b.fast.setSessionFastMode(appendParent, parent, false);
    assert.equal(a.fast.sessionFastMode(childId, true), false);
    for (const customType of [b.inline.CODEX_IDENTITY_CUSTOM_TYPE, b.fast.FAST_MODE_CUSTOM_TYPE]) {
      assert.equal(child.getEntries().filter(entry => entry.customType === customType).length, 1);
    }
    assert.ok(extensions.every(extension => !extension.tools.size && !extension.commands.size));
    assert.equal(host.pendingProviderRegistrations.length, 0);
  } finally {
    await emit("session_shutdown");
    host.invalidate();
  }
  assert.ok(broker.closed);
  previous = broker;
}

const stop = bus.on(a.runtime.CODEX_BROKER_CHANNEL, request => request.accept({ ...previous, closed: false, version: 2 }));
try {
  for (const factory of [a.runtime.ensureCodexServices, b.inline.createCodexSubagentInlineExtension().factory]) {
    const host = createExtensionRuntime();
    try { await assert.rejects(loadExtensionFromFactory(factory, cwdA, bus, host), /Incompatible or duplicate Codex/); }
    finally { host.invalidate(); }
  }
} finally { stop(); }
